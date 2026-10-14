import json
import logging
import os
import secrets
import socket
import tempfile
import time
import uuid
from pathlib import Path
from io import BytesIO
from urllib.parse import urlsplit

import requests
import websocket
import qrcode
from PIL import Image, ImageOps
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates


BASE_DIR = Path(__file__).resolve().parent
SETTINGS = json.loads((BASE_DIR / "studio_config.json").read_text(encoding="utf-8"))
OUTPUT_SIZE = (SETTINGS["output_width"], SETTINGS["output_height"])
if any(not isinstance(size, int) or size < 64 or size > 4096 or size % 16 for size in OUTPUT_SIZE):
    raise ValueError("출력 크기는 64~4096 범위의 16 배수여야 합니다.")


def save_fixed_photo(content: bytes, destination: Path):
    with Image.open(BytesIO(content)) as source:
        photo = ImageOps.exif_transpose(source).convert("RGB")
        # Usually already the requested size; preserve the full photo if a backend differs.
        photo = ImageOps.pad(photo, OUTPUT_SIZE, method=Image.Resampling.LANCZOS, color="#f5f6f2")
        photo.save(destination, format="PNG")



def generate(
    person_path,
    background_path,
    workflow_path=None,
    output_dir="results",
    prompt=None,
    server="http://192.168.1.91:8000",
    wait_seconds=600,
):
    server = server.rstrip("/")
    job_id = uuid.uuid4().hex

    if workflow_path is None:
        workflow_path = Path(__file__).resolve().with_name("composition.json")

    # 호출마다 새로 읽어 요청 간 설정이 섞이지 않게 합니다.
    workflow = json.loads(
        Path(workflow_path).read_text(encoding="utf-8-sig")
    )
    # Keep scheduler and latent dimensions consistent across both generation stages.
    for node_id in ("151:62", "151:66", "150:109", "150:115"):
        workflow[node_id]["inputs"]["width"] = OUTPUT_SIZE[0]
        workflow[node_id]["inputs"]["height"] = OUTPUT_SIZE[1]

    with requests.Session() as session:
        def upload(path):
            path = Path(path)
            with path.open("rb") as image:
                response = session.post(
                    f"{server}/upload/image",
                    files={
                        "image": (
                            f"{uuid.uuid4().hex}{path.suffix}",
                            image,
                        )
                    },
                    data={"type": "input", "overwrite": "false"},
                    timeout=60,
                )
            response.raise_for_status()
            uploaded = response.json()
            subfolder = uploaded.get("subfolder", "")
            return (
                f"{subfolder}/{uploaded['name']}"
                if subfolder else uploaded["name"]
            )

        workflow["147"]["inputs"]["image"] = upload(person_path)
        workflow["148"]["inputs"]["image"] = upload(background_path)
        workflow["150:105"]["inputs"]["noise_seed"] = secrets.randbits(48)
        workflow["146"]["inputs"]["filename_prefix"] = f"api_{job_id}"

        if prompt is not None:
            workflow["150:113"]["inputs"]["text"] = prompt

        # 1. WebSocket 연결 설정 (실행 상태 실시간 모니터링)
        ws_url = server.replace("http://", "ws://").replace("https://", "wss://")
        ws = websocket.WebSocket()

        try:
            ws.connect(f"{ws_url}/ws?clientId={job_id}", timeout=30)
            # 2. 실행 요청
            response = session.post(
                f"{server}/prompt",
                json={"prompt": workflow, "client_id": job_id},
                timeout=30,
            )
            if not response.ok:
                raise RuntimeError(
                    f"워크플로 제출 실패: {response.status_code}\n"
                    f"{response.text}"
                )

            submitted = response.json()
            if submitted.get("node_errors") or "prompt_id" not in submitted:
                raise RuntimeError(f"노드 검증 실패: {submitted}")

            prompt_id = submitted["prompt_id"]
            deadline = time.monotonic() + wait_seconds

            # 3. WebSocket을 통해 현재 작업의 완료 여부 수신
            completed = False
            while time.monotonic() < deadline:
                ws.settimeout(1.0)  # 1초 대기 타임아웃
                try:
                    message = ws.recv()
                    if message == "":
                        raise RuntimeError("ComfyUI WebSocket 연결이 종료되었습니다.")
                    if message and isinstance(message, str):
                        data = json.loads(message)
                        event = data.get("data", {})
                        if event.get("prompt_id") == prompt_id and data.get("type") in (
                            "execution_error", "execution_interrupted"
                        ):
                            raise RuntimeError(f"생성 실패: {event}")
                        if data.get("type") == "executing":
                            exec_data = data.get("data", {})
                            # 현재 작업 ID와 일치하고 노드가 None이면(실행 종료) 완료된 것으로 판단
                            if exec_data.get("prompt_id") == prompt_id and exec_data.get("node") is None:
                                completed = True
                                break
                except websocket.WebSocketTimeoutException:
                    continue

            if not completed:
                raise TimeoutError(
                    f"결과 대기 시간 초과. prompt_id={prompt_id}\n"
                    "서버 작업은 계속 실행 중일 수 있습니다."
                )

        finally:
            ws.close()

        # 4. 히스토리 조회하여 결과 이미지 가져오기
        response = session.get(
            f"{server}/history/{prompt_id}", timeout=30
        )
        response.raise_for_status()
        history = response.json().get(prompt_id)

        if not history:
            raise RuntimeError(f"작업 히스토리를 찾을 수 없습니다. prompt_id={prompt_id}")

        status = history.get("status", {})
        if status.get("status_str") == "error":
            raise RuntimeError(
                f"생성 실패: {status.get('messages', [])}"
            )

        images = (
            history.get("outputs", {})
            .get("146", {})
            .get("images", [])
        )
        if not images:
            raise RuntimeError(f"저장된 이미지가 없습니다: {history}")

        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        saved_paths = []

        for index, image in enumerate(images):
            response = session.get(
                f"{server}/view",
                params={
                    "filename": image["filename"],
                    "subfolder": image.get("subfolder", ""),
                    "type": image.get("type", "output"),
                },
                timeout=60,
            )
            response.raise_for_status()

            destination = output_dir / f"{job_id}_{index}.png"
            save_fixed_photo(response.content, destination)
            saved_paths.append(destination)

        return saved_paths


app = FastAPI(title="이미지 스튜디오", docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=[str(BASE_DIR), str(BASE_DIR / "templates")])
logger = logging.getLogger(__name__)
THEMES = {
    "park": {"title": "초록 공원", "description": "푸른 하늘 아래 여유로운 산책", "file": "images.jpg"},
    "alley": {"title": "고즈넉한 골목", "description": "오래된 골목에서 만나는 여행의 순간", "file": "a0000412_parts_5860d9429348e.webp"},
    "city": {"title": "활기찬 거리", "description": "색다른 도시의 분위기를 담은 장면", "file": "news-p.v1.20240223.5186a33e97024a6a92acec8dbae5dfa4_P1.png"},
}


@app.get("/", include_in_schema=False)
def home(request: Request):
    return templates.TemplateResponse(request=request, name="index.html", context={"themes": THEMES})


@app.get("/themes/{theme_id}", include_in_schema=False)
def theme_image(theme_id: str):
    theme = THEMES.get(theme_id)
    if theme is None:
        raise HTTPException(status_code=404, detail="테마를 찾을 수 없습니다.")
    return FileResponse(BASE_DIR / "B" / theme["file"])


@app.get("/docs", include_in_schema=False)
@app.get("/redoc", include_in_schema=False)
def old_docs():
    return RedirectResponse("/")


@app.get("/results/{filename}", include_in_schema=False)
def result_image(filename: str):
    return FileResponse(result_path(filename))


def result_path(filename: str):
    directory = (BASE_DIR / "results").resolve()
    path = (directory / filename).resolve()
    if path.parent != directory or path.suffix.lower() not in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"} or not path.is_file():
        raise HTTPException(status_code=404, detail="이미지를 찾을 수 없습니다.")
    return path


def share_base_url(request: Request):
    configured = os.environ.get("PUBLIC_BASE_URL", SETTINGS.get("public_base_url", "")).rstrip("/")
    if configured:
        return configured
    # Use the LAN interface that reaches ComfyUI, never a phone's localhost.
    backend = urlsplit(os.environ.get("COMFYUI_SERVER", "http://192.168.1.91:8000"))
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as connection:
        connection.connect((backend.hostname, backend.port or 80))
        address = connection.getsockname()[0]
    return f"http://{address}:{request.url.port or 80}"


@app.get("/share/{filename}", include_in_schema=False)
def share_photo(request: Request, filename: str):
    path = result_path(filename)
    return templates.TemplateResponse(
        request=request, name="templates/share.html",
        context={"filename": path.name},
        headers={"Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow"},
    )


@app.get("/share/{filename}/qr", include_in_schema=False)
def share_qr(request: Request, filename: str):
    path = result_path(filename)
    code = qrcode.make(f"{share_base_url(request)}/share/{path.name}")
    buffer = BytesIO()
    code.save(buffer, format="PNG")
    return Response(buffer.getvalue(), media_type="image/png", headers={"Cache-Control": "no-store"})


@app.get("/share/{filename}/download", include_in_schema=False)
def download_photo(filename: str):
    path = result_path(filename)
    return FileResponse(path, filename=path.name)


def save_upload(upload: UploadFile, directory: Path, name: str):
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}:
        raise HTTPException(status_code=400, detail=f"{name}: 지원하지 않는 이미지 확장자입니다.")
    destination = directory / f"{name}{suffix}"
    size = 0
    with destination.open("wb") as target:
        while chunk := upload.file.read(1024 * 1024):
            size += len(chunk)
            if size > 25 * 1024 * 1024:
                raise HTTPException(status_code=413, detail=f"{name}: 최대 25MB까지 업로드할 수 있습니다.")
            target.write(chunk)
    if size == 0:
        raise HTTPException(status_code=400, detail=f"{name}: 빈 파일입니다.")
    return destination


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/generate")
def generate_image(
    image_1: UploadFile = File(..., title="이미지 1", description="이미지 1 (인물)", json_schema_extra={"format": "binary"}),
    image_2: UploadFile | None = File(default=None),
    theme_id: str | None = Form(default=None),
    prompt: str | None = Form(default=None),
    wait_seconds: int = Form(default=600, ge=1, le=3600),
):
    try:
        if (theme_id is None) == (image_2 is None):
            raise HTTPException(status_code=400, detail="배경 테마를 선택해 주세요.")
        if theme_id is not None and theme_id not in THEMES:
            raise HTTPException(status_code=400, detail="사용할 수 없는 배경 테마입니다.")
        # 요청마다 별도 폴더를 사용하며 성공/실패 후 업로드 임시 파일을 정리합니다.
        with tempfile.TemporaryDirectory(prefix="composition_") as directory:
            person_path = save_upload(image_1, Path(directory), "image_1")
            background_path = (
                BASE_DIR / "B" / THEMES[theme_id]["file"]
                if theme_id is not None else save_upload(image_2, Path(directory), "image_2")
            )
            saved = generate(
                person_path=person_path,
                background_path=background_path,
                output_dir=BASE_DIR / "results",
                prompt=prompt,
                server=os.environ.get("COMFYUI_SERVER", "http://192.168.1.91:8000"),
                wait_seconds=wait_seconds,
            )
    except HTTPException:
        raise
    except (TimeoutError, requests.Timeout, websocket.WebSocketTimeoutException) as exc:
        logger.warning("이미지 생성 대기 시간 초과: %s", exc)
        raise HTTPException(status_code=504, detail="생성이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.") from exc
    except (requests.RequestException, websocket.WebSocketException, RuntimeError) as exc:
        logger.warning("이미지 생성 서비스 오류: %s", exc)
        raise HTTPException(status_code=502, detail="이미지를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.") from exc
    except Exception as exc:
        logger.exception("이미지 생성 요청 처리 실패")
        raise HTTPException(status_code=500, detail="처리 중 문제가 발생했습니다. 다시 시도해 주세요.") from exc
    finally:
        image_1.file.close()
        if image_2 is not None:
            image_2.file.close()
    return {"images": [f"/results/{path.name}" for path in saved]}


if __name__ == "__main__":
    import argparse
    import uvicorn

    parser = argparse.ArgumentParser(description="이미지 생성 API 서버")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    uvicorn.run(app, host=args.host, port=args.port)
