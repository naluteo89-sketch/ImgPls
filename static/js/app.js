const $ = id => document.getElementById(id);
let person = null;
let previewUrl = null;
let theme = null;
let busy = false;
let step = 1;
let selectionVersion = 0;
let cameraStream = null;
let cameraVersion = 0;
let capturing = false;
let cameraTimer = null;
let slideTimer = null;
let slideIndex = 0;
let slidesPaused = false;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const radios = [...document.querySelectorAll('input[name="theme"]')];
const emptyPreview = [...$('preview1').childNodes].map(node => node.cloneNode(true));

function message(text, error = false) {
  $('status').className = error ? 'error' : '';
  $('status').textContent = text;
}
function update() {
  const cameraOpen = !$('camera-panel').hidden;
  $('next').disabled = busy || !person || cameraOpen;
  $('submit').disabled = busy || !person || !theme;
  $('choose1').textContent = cameraOpen ? '캡처하고 다음으로' : (person ? '다른 사진 선택' : '인물 사진 선택');
  $('choose1').disabled = busy || (cameraOpen && (capturing || !cameraStream || $('camera-video').readyState < 2 || !$('camera-video').videoWidth));
  $('preview1').disabled = busy || cameraOpen;
  $('open-camera').textContent = cameraOpen ? '웹캠 닫기' : '웹캠 화면 열기';
  $('open-camera').disabled = busy;
  $('back').disabled = busy;
  $('cancel-photo').hidden = !person;
  $('cancel-photo').disabled = busy;
  $('cancel-photo-theme').disabled = busy;
  radios.forEach(input => input.disabled = busy);
}
function showStep(value) {
  if (value !== 1) closeCamera();
  step = value;
  $('footer-home').hidden = value === 1;
  $('person-step').hidden = value !== 1;
  $('theme-step').hidden = value !== 2;
  $('result').hidden = value !== 3;
  const titles = ['사진을 올려주세요.', '어떤 장면 속에 있고 싶나요?', '새로운 장면이 완성되었어요.'];
  const descriptions = ['사진 한 장을 올리고, 나에게 어울리는 배경을 골라 보세요.', '마음에 드는 배경 테마를 선택해 주세요.', '완성된 사진을 확인하고 소장해 보세요.'];
  $('page-title').textContent = titles[value - 1];
  $('page-description').textContent = descriptions[value - 1];
  for (let n = 1; n <= 3; n++) {
    if (n === value) $('indicator' + n).setAttribute('aria-current', 'step');
    else $('indicator' + n).removeAttribute('aria-current');
  }
  message('');
  update();
  $('page-title').focus();
}
function openPhotoPicker() {
  if (!busy && $('camera-panel').hidden) $('image1').click();
}
function closeCamera() {
  clearTimeout(cameraTimer);
  cameraVersion++;
  capturing = false;
  if (cameraStream) cameraStream.getTracks().forEach(track => track.stop());
  cameraStream = null;
  $('camera-video').srcObject = null;
  $('camera-panel').hidden = true;
  $('camera-video').hidden = true;
  $('camera-badge').hidden = true;
  $('preview1').hidden = false;
  $('open-camera').setAttribute('aria-expanded', 'false');
  update();
}
$('camera-video').onloadeddata = update;
$('camera-video').oncanplay = update;
function cameraError(text) {
  $('camera-error').hidden = false;
  $('camera-error').textContent = text;
  message(text, true);
}
$('open-camera').onclick = async () => {
  if (busy) return;
  if (!$('camera-panel').hidden) {
    selectionVersion++;
    closeCamera();
    $('open-camera').focus();
    return;
  }
  $('camera-error').hidden = true;
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraError('이 접속 환경에서는 카메라 기능을 사용할 수 없습니다. 서버 PC의 Chrome 또는 Edge에서 http://localhost:8000 으로 접속해 주세요. 다른 PC에서는 HTTPS 접속이 필요합니다.');
    return;
  }
  const version = ++cameraVersion;
  selectionVersion++;
  $('camera-panel').hidden = false;
  $('camera-video').hidden = false;
  $('camera-badge').hidden = false;
  $('preview1').hidden = true;
  $('open-camera').setAttribute('aria-expanded', 'true');
  $('camera-status').textContent = '카메라 연결 중입니다. 브라우저의 카메라 사용 요청을 허용해 주세요.';
  message('');
  update();
  $('open-camera').focus();
  $('camera-panel').scrollIntoView({block: 'nearest'});
  cameraTimer = setTimeout(() => {
    if (version !== cameraVersion) return;
    selectionVersion++;
    closeCamera();
    cameraError('카메라 연결 또는 영상 재생이 30초 동안 완료되지 않았습니다. 브라우저의 카메라 권한 요청을 확인해 주세요. 내장 브라우저에서 권한 요청이 나타나지 않으면 Chrome 또는 Edge에서 같은 주소로 접속해 주세요.');
  }, 30000);
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false
    });
    if (version !== cameraVersion) { stream.getTracks().forEach(track => track.stop()); return; }
    cameraStream = stream;
    stream.getVideoTracks().forEach(track => track.addEventListener('ended', () => {
      if (version !== cameraVersion) return;
      selectionVersion++;
      closeCamera();
      message('웹캠 연결이 끊겼습니다. 연결을 확인하고 다시 열어 주세요.', true);
    }));
    $('camera-video').srcObject = stream;
    $('camera-video').muted = true;
    $('camera-video').playsInline = true;
    $('camera-status').textContent = '웹캠이 연결되었습니다. 영상을 불러오는 중입니다.';
    await $('camera-video').play();
    if (version !== cameraVersion) return;
    clearTimeout(cameraTimer);
    $('camera-status').textContent = '준비되면 캡처해 주세요';
    update();
  } catch (error) {
    if (version !== cameraVersion) return;
    closeCamera();
    const errors = {
      NotAllowedError: '카메라 사용이 차단되었습니다. 주소창의 사이트 설정에서 카메라를 허용하고, Windows 설정 → 개인정보 및 보안 → 카메라에서 데스크톱 앱의 카메라 접근을 확인해 주세요.',
      NotFoundError: '연결된 웹캠이 없습니다. 웹캠을 연결하거나 인물 사진을 선택해 주세요.',
      NotReadableError: '웹캠을 열 수 없습니다. 다른 앱에서 사용 중인지 확인해 주세요.'
    };
    console.warn('Webcam startup failed:', error.name, error.message);
    cameraError((errors[error.name] || '웹캠을 시작하지 못했습니다. 연결 상태와 카메라 권한을 확인해 주세요.') + '\n오류 코드: ' + (error.name || 'UnknownError'));
  }
};
function capturePhoto() {
  const video = $('camera-video');
  if (capturing || !cameraStream || video.readyState < 2 || !video.videoWidth) return;
  const version = cameraVersion;
  capturing = true;
  update();
  const failed = () => {
    capturing = false;
    $('camera-status').textContent = '촬영하지 못했습니다. 다시 캡처해 주세요.';
    update();
  };
  try {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d').drawImage(video, 0, 0);
    canvas.toBlob(blob => {
      if (version !== cameraVersion) return;
      if (!blob) { failed(); return; }
      selectPhoto(new File([blob], `webcam-${Date.now()}.jpg`, {type: 'image/jpeg'}), true);
    }, 'image/jpeg', 0.95);
  } catch { failed(); }
}
window.addEventListener('pagehide', () => { selectionVersion++; closeCamera(); stopSlideTimer(); });
function stopSlideTimer() {
  clearInterval(slideTimer);
  slideTimer = null;
}
function showSlide(index) {
  slideIndex = (index + 3) % 3;
  $('generation-track').style.transform = `translateX(-${slideIndex * 100}%)`;
  [...$('generation-track').children].forEach((slide, i) => {
    slide.setAttribute('aria-hidden', String(i !== slideIndex));
    if (i === slideIndex) $('loading-dot-' + i).setAttribute('aria-current', 'true');
    else $('loading-dot-' + i).removeAttribute('aria-current');
  });
}
function scheduleSlides() {
  stopSlideTimer();
  if (!slidesPaused && !$('generating').hidden && !document.hidden) {
    slideTimer = setInterval(() => showSlide(slideIndex + 1), 6000);
  }
  $('loading-pause').textContent = slidesPaused ? '자동 넘김 시작' : '자동 넘김 일시정지';
}
function moveSlide(index) { showSlide(index); scheduleSlides(); }
$('loading-prev').onclick = () => moveSlide(slideIndex - 1);
$('loading-next').onclick = () => moveSlide(slideIndex + 1);
for (let i = 0; i < 3; i++) $('loading-dot-' + i).onclick = () => moveSlide(i);
$('loading-pause').onclick = () => { slidesPaused = !slidesPaused; scheduleSlides(); };
document.addEventListener('visibilitychange', scheduleSlides);
reducedMotion.addEventListener('change', () => { slidesPaused = reducedMotion.matches; scheduleSlides(); });
function startLoading(personUrl, themeUrl, themeName) {
  $('loading-person').src = personUrl;
  $('loading-theme').src = themeUrl;
  $('loading-theme-name').textContent = themeName;
  $('theme-step').hidden = true;
  $('generating').hidden = false;
  $('form').setAttribute('aria-busy', 'true');
  slidesPaused = reducedMotion.matches;
  showSlide(0);
  scheduleSlides();
  $('generation-title').focus();
}
function stopLoading() {
  stopSlideTimer();
  $('generating').hidden = true;
  $('form').removeAttribute('aria-busy');
  $('theme-step').hidden = step !== 2;
  if (step === 2) $('submit').focus();
}
$('choose1').onclick = () => {
  if (busy) return;
  if ($('camera-panel').hidden) openPhotoPicker();
  else capturePhoto();
};
$('preview1').onclick = openPhotoPicker;
function cancelPhoto() {
  if (busy) return;
  closeCamera();
  // Ignore any preview still loading for a previously selected file.
  selectionVersion++;
  person = null;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  $('image1').value = '';
  $('preview1').replaceChildren(...emptyPreview.map(node => node.cloneNode(true)));
  $('person-thumb').removeAttribute('src');
  $('name1').textContent = '선택된 사진이 없습니다';
  $('choose1').textContent = '인물 사진 선택';
  $('gallery').replaceChildren();
  $('result-person').removeAttribute('src');
  $('result-theme').removeAttribute('src');
  $('result-theme-name').textContent = '배경 테마';
  showStep(1);
  message('사진 선택을 취소했습니다. 새 사진을 선택해 주세요.');
  $('choose1').focus();
}
$('cancel-photo').onclick = cancelPhoto;
$('cancel-photo-theme').onclick = cancelPhoto;
$('image1').onchange = () => {
  const file = $('image1').files[0];
  if (!file) return;
  selectPhoto(file);
};
function selectPhoto(file, fromCamera = false) {
  const version = ++selectionVersion;
  if (!/\.(png|jpe?g|webp|bmp|gif)$/i.test(file.name) || !file.size || file.size > 25 * 1024 * 1024) {
    message('25MB 이하의 이미지 파일을 선택해 주세요.', true);
    $('image1').value = '';
    capturing = false;
    update();
    return;
  }
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.alt = '선택한 인물 사진 미리보기';
  image.onload = () => {
    if (version !== selectionVersion) { URL.revokeObjectURL(url); return; }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = url;
    person = file;
    $('preview1').replaceChildren(image);
    $('person-thumb').src = url;
    $('name1').textContent = file.name;
    $('choose1').textContent = '다른 사진 선택';
    message('사진이 준비되었습니다. 다음으로 이동해 주세요.');
    update();
    if (fromCamera) showStep(2);
  };
  image.onerror = () => {
    URL.revokeObjectURL(url);
    if (version !== selectionVersion) return;
    $('image1').value = '';
    message('사진을 열 수 없습니다. 다른 파일을 선택해 주세요.', true);
    capturing = false;
    update();
  };
  image.src = url;
}
$('next').onclick = () => { if (person && !busy) showStep(2); };
$('back').onclick = () => { if (!busy) showStep(1); };
$('again').onclick = () => showStep(2);
radios.forEach(input => input.onchange = () => {
  theme = input.value;
  $('theme-note').textContent = input.closest('label').querySelector('strong').textContent + ' 테마를 선택했습니다.';
  update();
});
$('form').onsubmit = async event => {
  event.preventDefault();
  if (step !== 2 || busy || !person || !theme) return;
  const sourcePersonUrl = previewUrl;
  const sourceTheme = radios.find(input => input.value === theme).closest('label');
  const sourceThemeUrl = sourceTheme.querySelector('img').src;
  const sourceThemeName = sourceTheme.querySelector('strong').textContent;
  busy = true;
  update();
  $('submit').textContent = '사진 만드는 중…';
  message('선택한 장면으로 사진을 만들고 있습니다. 몇 분 정도 걸릴 수 있습니다.');
  startLoading(sourcePersonUrl, sourceThemeUrl, sourceThemeName);
  const data = new FormData();
  data.append('image_1', person);
  data.append('theme_id', theme);
  try {
    const response = await fetch('/generate', {method: 'POST', body: data});
    const result = await response.json();
    if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : '사진을 처리하지 못했습니다. 다시 시도해 주세요.');
    if (!Array.isArray(result.images) || !result.images.length) throw new Error('완성된 사진이 없습니다. 다시 시도해 주세요.');
    $('gallery').replaceChildren();
    result.images.forEach((url, i) => {
      const block = document.createElement('div');
      block.className = 'result-item';
      const image = document.createElement('img');
      image.src = url;
      image.alt = '완성된 사진 ' + (i + 1);
      const link = document.createElement('a');
      link.href = url;
      link.download = url.split('/').pop();
      link.className = 'download';
      link.textContent = '사진 다운로드 ↓';
      block.append(image, link);
      const share = document.createElement('div');
      share.className = 'photo-share';
      const filename = url.split('/').pop();
      const qr = document.createElement('img');
      qr.className = 'share-qr';
      qr.src = '/share/' + filename + '/qr';
      qr.alt = '완성된 사진을 휴대폰으로 받는 QR 코드';
      const explanation = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = 'QR로 내 사진 받기';
      const note = document.createElement('p');
      note.className = 'note';
      note.textContent = '같은 Wi-Fi에 연결한 휴대폰 카메라로 스캔해 주세요.';
      qr.onerror = () => { qr.hidden = true; note.textContent = 'QR 코드를 불러오지 못했습니다. 다운로드 버튼을 이용해 주세요.'; };
      explanation.append(title, note);
      share.append(qr, explanation);
      block.append(share);
      $('gallery').append(block);
    });
    $('result-person').src = sourcePersonUrl;
    $('result-theme').src = sourceThemeUrl;
    $('result-theme-name').textContent = sourceThemeName;
    showStep(3);
  } catch (error) {
    message(error instanceof TypeError ? '연결 상태를 확인한 뒤 다시 시도해 주세요.' : error.message, true);
  } finally {
    busy = false;
    $('submit').textContent = '이 배경으로 만들기 ↗';
    update();
    stopLoading();
  }
};
