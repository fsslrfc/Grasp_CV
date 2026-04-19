const STREAM_URL = '/video';
const CALIBRATION_POINT_NAMES = ['左上', '右上', '左下', '右下'];

let currentTargets = [];
let selectedTrackId = null;
let pollingTimer = null;
let currentMode = 'calibration';
let currentOperationMode = 'grasp';
let activeCalibrationPoint = null;
let currentImageWidth = 0;
let currentImageHeight = 0;
let selectedPlacePoint = null;
let calibrationState = createEmptyCalibrationState();

function createEmptyCalibrationState() {
  return {
    confirmed: false,
    ready: false,
    plane_z: null,
    points: Array.from({ length: 4 }, (_, index) => ({
      index,
      pixel: [null, null],
      robot: [null, null, null],
      pixel_ready: false,
      robot_ready: false,
      ready: false
    }))
  };
}

function normalizeCalibrationState(data) {
  const state = createEmptyCalibrationState();
  if (!data) return state;

  state.confirmed = Boolean(data.confirmed);
  state.ready = Boolean(data.ready);
  state.plane_z = data.plane_z ?? null;

  if (Array.isArray(data.points)) {
    data.points.slice(0, 4).forEach((point, index) => {
      state.points[index] = {
        index,
        pixel: Array.isArray(point.pixel) ? point.pixel : [null, null],
        robot: Array.isArray(point.robot) ? point.robot : [null, null, null],
        pixel_ready: Boolean(point.pixel_ready),
        robot_ready: Boolean(point.robot_ready),
        ready: Boolean(point.ready)
      };
    });
  }

  return state;
}

function setStatus(text, className = '') {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = 'info-box ' + className;
}

function setCalibrationStatus(text, className = '') {
  const el = document.getElementById('calibration-status');
  el.textContent = text;
  el.className = 'info-box ' + className;
}

function setStreamForMode() {
  const streamImg = document.getElementById('main-stream');
  if (!streamImg) return;

  if (streamImg.getAttribute('src') !== STREAM_URL) {
    streamImg.setAttribute('src', STREAM_URL);
  }
}

function switchMode(mode) {
  currentMode = mode;
  if (mode === 'operate') {
    activeCalibrationPoint = null;
  }

  document.getElementById('calibration-screen').classList.toggle('active', mode === 'calibration');
  document.getElementById('operate-screen').classList.toggle('active', mode === 'operate');
  setStreamForMode();
  renderPlaceSelection();
}

function syncInputValue(inputId, value) {
  const input = document.getElementById(inputId);
  if (document.activeElement === input) return;
  input.value = value ?? '';
}

function formatPoint(point) {
  if (!point || point[0] === null || point[1] === null) {
    return '未标定';
  }
  return `(${point[0]}, ${point[1]})`;
}

function roundNorm(value) {
  return Math.round(value * 10000) / 10000;
}

function formatTargetPoint(data) {
  return `X=${data.target_x}, Y=${data.target_y}, Z=${data.target_z}`;
}

function formatReason(reason) {
  switch (reason) {
    case 'calibration_required':
      return '请先完成标定';
    case 'target_not_found':
      return '未选中任何目标';
    case 'target_lost':
      return '目标已丢失，请重新选择';
    case 'missing_click_point':
      return '缺少点击坐标';
    case 'invalid_click_point':
      return '点击坐标无效';
    case 'invalid_number':
      return '请输入有效数字';
    case 'point_out_of_workspace':
      return '放置点不在标定区域内';
    case 'image_not_ready':
      return '图像尚未就绪';
    default:
      return reason || 'unknown';
  }
}

function buildActionPayload(option, data) {
  const payload = {
    option,
    source: 'vision_web',
    target_x: data.target_x,
    target_y: data.target_y,
    target_z: data.target_z,
    pixel_x: data.pixel_x,
    pixel_y: data.pixel_y,
    timestamp: Date.now()
  };

  if (option === 'grasp') {
    payload.track_id = data.track_id;
    payload.class_name = data.class_name;
    payload.center_norm = data.center_norm;
  } else {
    payload.click_x_norm = data.click_x_norm;
    payload.click_y_norm = data.click_y_norm;
  }

  return payload;
}

function notifyNativeAction(payload) {
  const bridge = window.ohosApp;
  if (!bridge || typeof bridge.onVisionAction !== 'function') {
    console.warn('[Bridge] 原生桥未就绪，保留页面结果', payload);
    return { sent: false, reason: 'bridge_unavailable' };
  }

  try {
    bridge.onVisionAction(JSON.stringify(payload));
    return { sent: true };
  } catch (err) {
    console.error('[Bridge] 调用原生桥失败', err);
    return { sent: false, reason: 'bridge_failed' };
  }
}

function updateOperationControls() {
  const placeModeBtn = document.getElementById('place-mode-btn');
  const graspBtn = document.getElementById('grasp-btn');

  if (!placeModeBtn || !graspBtn) return;

  const isPlaceMode = currentOperationMode === 'place';
  graspBtn.dataset.mode = isPlaceMode ? 'place' : 'grasp';
  graspBtn.textContent = isPlaceMode ? '发送放置坐标' : '发送抓取坐标';

  placeModeBtn.dataset.mode = isPlaceMode ? 'grasp' : 'place';
  placeModeBtn.textContent = isPlaceMode ? '进入抓取模式' : '进入放置模式';

  if (isPlaceMode) {
    graspBtn.disabled = !selectedPlacePoint;
    return;
  }

  graspBtn.disabled = selectedTrackId === null;
}

function renderPlaceSelection() {
  const marker = document.getElementById('place-point-marker');
  const visible = currentMode === 'operate' && currentOperationMode === 'place' && selectedPlacePoint;

  if (!marker) return;

  marker.classList.toggle('visible', Boolean(visible));
  if (!visible) {
    return;
  }

  marker.style.left = `${selectedPlacePoint.normX * 100}%`;
  marker.style.top = `${selectedPlacePoint.normY * 100}%`;
}

function renderOperationMode() {
  const el = document.getElementById('operation-mode');
  if (!el) return;

  if (currentOperationMode === 'place') {
    el.textContent = '当前模式：放置模式，点击上方画面选择放置点';
    el.className = 'info-box warning';
  } else {
    el.textContent = '当前模式：抓取模式，点击上方画面或下方列表锁定目标';
    el.className = 'info-box locked';
  }

  updateOperationControls();
}

function setOperationMode(mode) {
  currentOperationMode = mode === 'place' ? 'place' : 'grasp';
  renderOperationMode();
  renderPlaceSelection();
}

function renderCalibrationState(calibration) {
  calibrationState = normalizeCalibrationState(calibration);

  calibrationState.points.forEach((point, index) => {
    syncInputValue(`robot-x-${index}`, point.robot[0]);
    syncInputValue(`robot-y-${index}`, point.robot[1]);
    syncInputValue(`robot-z-${index}`, point.robot[2]);

    const card = document.getElementById(`cal-card-${index}`);
    const button = document.getElementById(`mark-btn-${index}`);
    const pixelInfo = document.getElementById(`pixel-info-${index}`);
    const isArmed = activeCalibrationPoint === index && !point.pixel_ready;

    card.classList.toggle('armed', isArmed);
    const pointName = CALIBRATION_POINT_NAMES[index];
    button.className = 'mark-btn ' + (point.pixel_ready ? 'done' : (isArmed ? 'armed' : 'pending'));
    button.textContent = point.pixel_ready
      ? `${pointName}图像已标定`
      : (isArmed ? `点击上方图像记录${pointName}` : `标定坐标`);
    pixelInfo.textContent = '像素: ' + formatPoint(point.pixel);
  });

  const completeBtn = document.getElementById('calibration-complete-btn');
  completeBtn.disabled = !(calibrationState.ready && !calibrationState.confirmed);
  completeBtn.textContent = calibrationState.confirmed ? '已完成标定' : '标定完成';

  if (calibrationState.confirmed) {
    const planeZText = calibrationState.plane_z === null ? '' : `，平面Z=${calibrationState.plane_z}`;
    setCalibrationStatus(`四点标定已完成${planeZText}，可以进入操作台进行目标选择与抓取`, 'ready');
  } else if (activeCalibrationPoint !== null) {
    setCalibrationStatus(`请点击上方图像，记录${CALIBRATION_POINT_NAMES[activeCalibrationPoint]}的像素坐标`, 'warning');
  } else if (calibrationState.ready) {
    setCalibrationStatus('四个点XYZ与像素信息已齐全，点击“标定完成”进入操作台', 'ready');
  } else {
    setCalibrationStatus('机械臂XYZ坐标输入和图像标定不分先后，每次完成后都会同步到后端');
  }
}

function renderTargetList(targets) {
  const list = document.getElementById('target-list');
  if (!targets || targets.length === 0) {
    list.innerHTML = '<div class="target-empty">未检测到可抓取目标</div>';
    return;
  }

  list.innerHTML = targets.map(t => {
    const sel = t.track_id === selectedTrackId;
    return `<div class="target-item ${sel ? 'selected' : ''}" onclick="selectTarget(${t.track_id})">
      <div class="name">#${t.track_id} ${t.class_name}</div>
      <div class="conf">置信度: ${(t.confidence * 100).toFixed(0)}%</div>
    </div>`;
  }).join('');
}

function updateOperationState(data, prevSelected) {
  renderTargetList(currentTargets);
  document.getElementById('fps').textContent =
    'Frame #' + data.frame_id + ' | ' + currentTargets.length + ' 个目标';

  renderOperationMode();

  if (currentOperationMode === 'place') {
    if (selectedPlacePoint) {
      setStatus(`已选择放置点: (${selectedPlacePoint.pixelX}, ${selectedPlacePoint.pixelY})，点击“发送放置坐标”确认`, 'locked');
    } else {
      setStatus('放置模式：点击上方画面选择放置点', 'warning');
    }
    updateOperationControls();
    renderPlaceSelection();
    return;
  }

  if (selectedTrackId !== null) {
    setStatus('已锁定: #' + selectedTrackId + ' ' + (data.selection_class_name || ''), 'locked');
  } else if (prevSelected !== null) {
    setStatus('目标丢失', 'lost');
  } else {
    setStatus('标定完成，检测中...', 'ready');
  }

  updateOperationControls();
  renderPlaceSelection();
}

async function fetchState() {
  try {
    const resp = await fetch('/api/state?ts=' + Date.now(), { cache: 'no-store' });
    const data = await resp.json();

    const prevSelected = selectedTrackId;
    currentTargets = data.targets || [];
    selectedTrackId = data.selected_track_id ?? null;
    currentImageWidth = data.image_width || 0;
    currentImageHeight = data.image_height || 0;

    renderCalibrationState(data.calibration);

    if (calibrationState.confirmed) {
      switchMode('operate');
      updateOperationState(data, prevSelected);
    } else {
      setOperationMode('grasp');
      switchMode('calibration');
      updateOperationControls();
      document.getElementById('fps').textContent = 'Frame #' + data.frame_id;
    }
  } catch (err) {
    console.error('[HTTP] 获取状态失败', err);
    if (currentMode === 'operate') {
      setStatus('状态获取失败，正在重试...', 'lost');
    } else {
      setCalibrationStatus('状态获取失败，正在重试...', 'lost');
    }
  }
}

async function postJSON(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {})
  });

  let data = {};
  try {
    data = await resp.json();
  } catch (_) {}

  if (!resp.ok) {
    throw new Error(data.reason || ('HTTP ' + resp.status));
  }
  return data;
}

function parseNullableNumber(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text);
  if (Number.isNaN(number)) {
    throw new Error('invalid_number');
  }
  return number;
}

async function updateCalibrationRobotPoint(index) {
  try {
    const robotX = parseNullableNumber(document.getElementById(`robot-x-${index}`).value);
    const robotY = parseNullableNumber(document.getElementById(`robot-y-${index}`).value);
    const robotZ = parseNullableNumber(document.getElementById(`robot-z-${index}`).value);

    const data = await postJSON('/api/calibration/point', {
      point_index: index,
      robot_x: robotX,
      robot_y: robotY,
      robot_z: robotZ
    });

    renderCalibrationState(data.calibration);
    const pointName = CALIBRATION_POINT_NAMES[index];
    const currentPoint = normalizeCalibrationState(data.calibration).points[index];
    if (currentPoint.ready) {
      setCalibrationStatus(`${pointName}机械臂XYZ坐标已记录，当前点数据已完整同步到后端`, 'ready');
    }
    return true;
  } catch (err) {
    console.error('[HTTP] 保存机械臂坐标失败', err);
    setCalibrationStatus('保存机械臂坐标失败: ' + formatReason(err.message), 'lost');
    return false;
  }
}

async function armCalibrationPoint(index) {
  activeCalibrationPoint = index;
  renderCalibrationState(calibrationState);
}

function getImagePoint(event) {
  const img = event.target;
  const rect = img.getBoundingClientRect();

  if (!rect.width || !rect.height || !img.naturalWidth || !img.naturalHeight) {
    throw new Error('video_not_ready');
  }

  const intrinsicRatio = img.naturalWidth / img.naturalHeight;
  const elementRatio = rect.width / rect.height;

  let renderWidth;
  let renderHeight;
  let offsetX;
  let offsetY;

  if (intrinsicRatio > elementRatio) {
    renderWidth = rect.width;
    renderHeight = rect.width / intrinsicRatio;
    offsetX = 0;
    offsetY = (rect.height - renderHeight) / 2;
  } else {
    renderHeight = rect.height;
    renderWidth = rect.height * intrinsicRatio;
    offsetX = (rect.width - renderWidth) / 2;
    offsetY = 0;
  }

  const rawClickX = event.clientX - rect.left - offsetX;
  const rawClickY = event.clientY - rect.top - offsetY;

  const rawNormX = rawClickX / renderWidth;
  const rawNormY = rawClickY / renderHeight;

  const normX = Math.min(1, Math.max(0, rawNormX));
  const normY = Math.min(1, Math.max(0, rawNormY));

  const imageWidth = currentImageWidth || img.naturalWidth;
  const imageHeight = currentImageHeight || img.naturalHeight;

  return {
    normX,
    normY,
    pixelX: Math.min(imageWidth - 1, Math.max(0, Math.round(normX * imageWidth))),
    pixelY: Math.min(imageHeight - 1, Math.max(0, Math.round(normY * imageHeight)))
  };
}

function onMainImageClick(event) {
  if (currentMode === 'operate') {
    return onOperationImageClick(event);
  }
  return onCalibrationImageClick(event);
}

async function onCalibrationImageClick(event) {
  if (activeCalibrationPoint === null) {
    setCalibrationStatus('请先点击某个点下方的标定按钮', 'warning');
    return;
  }

  try {
    const pointIndex = activeCalibrationPoint;
    const pointName = CALIBRATION_POINT_NAMES[pointIndex];
    const { pixelX, pixelY } = getImagePoint(event);

    const data = await postJSON('/api/calibration/point', {
      point_index: pointIndex,
      pixel_x: pixelX,
      pixel_y: pixelY
    });

    activeCalibrationPoint = null;
    renderCalibrationState(data.calibration);
    const currentPoint = normalizeCalibrationState(data.calibration).points[pointIndex];
    if (currentPoint.ready) {
      setCalibrationStatus(`${pointName}图像坐标已记录，当前点数据已完整同步到后端`, 'ready');
    } else {
      setCalibrationStatus(`${pointName}像素坐标已记录: (${pixelX}, ${pixelY})`, 'ready');
    }
  } catch (err) {
    console.error('[HTTP] 保存图像坐标失败', err);
    setCalibrationStatus('保存图像坐标失败: ' + formatReason(err.message), 'lost');
  }
}

async function completeCalibration() {
  try {
    const data = await postJSON('/api/calibration/complete', {});
    activeCalibrationPoint = null;
    renderCalibrationState(data.calibration);
    setOperationMode('grasp');
    switchMode('operate');
    setStatus('标定完成，请点击上方画面或下方列表选择目标', 'ready');
    await fetchState();
  } catch (err) {
    console.error('[HTTP] 完成标定失败', err);
    setCalibrationStatus('完成标定失败: ' + formatReason(err.message), 'lost');
  }
}

async function selectTarget(trackId) {
  if (currentOperationMode === 'place') {
    setStatus('当前处于放置模式，请先切回抓取模式后再切换抓取目标', 'warning');
    return;
  }

  try {
    const data = await postJSON('/api/select', { track_id: trackId });
    selectedTrackId = data.track_id;
    setStatus('已锁定: #' + data.track_id + ' ' + (data.class_name || ''), 'locked');
    updateOperationControls();
    await fetchState();
  } catch (err) {
    console.error('[HTTP] 选择目标失败', err);
    setStatus('选择目标失败: ' + formatReason(err.message), 'lost');
  }
}

function enterPlaceMode() {
  if (!calibrationState.confirmed) {
    setStatus('请先完成标定', 'warning');
    return;
  }

  selectedPlacePoint = null;
  setOperationMode('place');
  setStatus('放置模式：点击上方画面选择放置点', 'warning');
}

function cancelPlaceMode() {
  selectedPlacePoint = null;
  setOperationMode('grasp');
  if (selectedTrackId !== null) {
    setStatus('已返回抓取模式，当前锁定目标 #' + selectedTrackId, 'locked');
  } else {
    setStatus('已返回抓取模式，请点击上方画面或下方列表选择目标', 'ready');
  }
}

function toggleOperationMode() {
  if (currentOperationMode === 'place') {
    cancelPlaceMode();
    return;
  }
  enterPlaceMode();
}

async function reopenCalibration() {
  try {
    const data = await postJSON('/api/calibration/reopen', {});
    activeCalibrationPoint = null;
    selectedPlacePoint = null;
    selectedTrackId = null;
    currentTargets = [];
    renderCalibrationState(data.calibration);
    setOperationMode('grasp');
    switchMode('calibration');
    setCalibrationStatus('已返回标定界面，可以修改标定数据', 'warning');
    await fetchState();
  } catch (err) {
    console.error('[HTTP] 重新标定失败', err);
    setStatus('重新标定失败: ' + formatReason(err.message), 'lost');
  }
}

async function sendPlace() {
  if (!selectedPlacePoint) return;

  const data = await postJSON('/api/place', {
    click_x_norm: roundNorm(selectedPlacePoint.normX),
    click_y_norm: roundNorm(selectedPlacePoint.normY)
  });

  const payload = buildActionPayload('place', data);
  const bridgeResult = notifyNativeAction(payload);

  selectedPlacePoint = null;
  setOperationMode('grasp');
  if (bridgeResult.sent) {
    setStatus('放置坐标已发送: ' + formatTargetPoint(data), 'locked');
  } else {
    setStatus('放置坐标已生成（原生桥未连接）: ' + formatTargetPoint(data), 'warning');
  }
}

async function onOperationImageClick(event) {
  try {
    const point = getImagePoint(event);
    const { normX, normY } = point;

    if (currentOperationMode === 'place') {
      selectedPlacePoint = point;
      renderPlaceSelection();
      updateOperationControls();
      setStatus(`已选择放置点: (${point.pixelX}, ${point.pixelY})，点击“发送放置坐标”确认`, 'locked');
      return;
    }

    let hit = null;
    for (const t of currentTargets) {
      const [x1, y1, x2, y2] = t.bbox_norm;
      if (normX >= x1 && normX <= x2 && normY >= y1 && normY <= y2) {
        hit = t;
        break;
      }
    }

    if (hit) {
      await selectTarget(hit.track_id);
      return;
    }

    const data = await postJSON('/api/click', {
      click_x_norm: roundNorm(normX),
      click_y_norm: roundNorm(normY)
    });

    if (data.track_id !== undefined) {
      selectedTrackId = data.track_id;
      setStatus('已锁定: #' + data.track_id + ' ' + (data.class_name || ''), 'locked');
      updateOperationControls();
    }
    await fetchState();
  } catch (err) {
    console.error('[HTTP] 点击操作失败', err);
    if (currentOperationMode === 'place') {
      setStatus('选择放置点失败: ' + formatReason(err.message), 'lost');
    } else {
      setStatus('未选中任何目标', 'lost');
    }
  }
}

async function sendGrasp() {
  const graspBtn = document.getElementById('grasp-btn');
  if (!graspBtn) return;

  if (currentOperationMode === 'place') {
    if (!selectedPlacePoint) return;

    graspBtn.disabled = true;
    setStatus('正在发送放置坐标...', 'warning');

    try {
      await sendPlace();
      await fetchState();
    } catch (err) {
      console.error('[HTTP] 放置失败', err);
      setStatus('放置失败: ' + formatReason(err.message), 'lost');
    } finally {
      updateOperationControls();
    }
    return;
  }

  if (selectedTrackId === null) return;

  graspBtn.disabled = true;
  setStatus('正在计算抓取坐标...', 'warning');

  try {
    const data = await postJSON('/api/grasp', { track_id: selectedTrackId });
    if (!data.success) {
      setStatus('抓取失败: ' + formatReason(data.reason), 'lost');
      return;
    }

    const payload = buildActionPayload('grasp', data);
    const bridgeResult = notifyNativeAction(payload);

    selectedPlacePoint = null;
    setOperationMode('place');
    if (bridgeResult.sent) {
      setStatus('抓取坐标已发送: ' + formatTargetPoint(data) + '，请在画面中选择放置点', 'locked');
    } else {
      setStatus('抓取坐标已生成（原生桥未连接）: ' + formatTargetPoint(data) + '，请在画面中选择放置点', 'warning');
    }
  } catch (err) {
    console.error('[HTTP] 抓取失败', err);
    setStatus('抓取失败: ' + formatReason(err.message), 'lost');
  } finally {
    updateOperationControls();
  }
}

function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  fetchState();
  pollingTimer = setInterval(fetchState, 250);
}

switchMode('calibration');
setOperationMode('grasp');
startPolling();
