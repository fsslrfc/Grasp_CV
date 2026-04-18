const STREAM_URL = '/video';
const CALIBRATION_POINT_NAMES = ['左上', '右上', '右下', '左下'];

let currentTargets = [];
let selectedTrackId = null;
let pollingTimer = null;
let currentMode = 'calibration';
let activeCalibrationPoint = null;
let currentImageWidth = 0;
let currentImageHeight = 0;
let calibrationState = createEmptyCalibrationState();

function createEmptyCalibrationState() {
  return {
    confirmed: false,
    ready: false,
    points: Array.from({ length: 4 }, (_, index) => ({
      index,
      pixel: [null, null],
      robot: [null, null],
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

  if (Array.isArray(data.points)) {
    data.points.slice(0, 4).forEach((point, index) => {
      state.points[index] = {
        index,
        pixel: Array.isArray(point.pixel) ? point.pixel : [null, null],
        robot: Array.isArray(point.robot) ? point.robot : [null, null],
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

function setStreamForMode(mode) {
  const calibrationImg = document.getElementById('calibration-stream');
  const operateImg = document.getElementById('operate-stream');

  if (mode === 'operate') {
    if (operateImg.getAttribute('src') !== STREAM_URL) {
      operateImg.setAttribute('src', STREAM_URL);
    }
    if (calibrationImg.getAttribute('src')) {
      calibrationImg.removeAttribute('src');
    }
  } else {
    if (calibrationImg.getAttribute('src') !== STREAM_URL) {
      calibrationImg.setAttribute('src', STREAM_URL);
    }
    if (operateImg.getAttribute('src')) {
      operateImg.removeAttribute('src');
    }
  }
}

function switchMode(mode) {
  currentMode = mode;
  if (mode === 'operate') {
    activeCalibrationPoint = null;
  }

  document.getElementById('calibration-screen').classList.toggle('active', mode === 'calibration');
  document.getElementById('operate-screen').classList.toggle('active', mode === 'operate');
  setStreamForMode(mode);
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

function renderCalibrationState(calibration) {
  calibrationState = normalizeCalibrationState(calibration);

  calibrationState.points.forEach((point, index) => {
    syncInputValue(`robot-x-${index}`, point.robot[0]);
    syncInputValue(`robot-y-${index}`, point.robot[1]);

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
    setCalibrationStatus('四点标定已完成，可以进入操作台进行目标选择与抓取', 'ready');
  } else if (activeCalibrationPoint !== null) {
    setCalibrationStatus(`请点击上方图像，记录${CALIBRATION_POINT_NAMES[activeCalibrationPoint]}的像素坐标`, 'warning');
  } else if (calibrationState.ready) {
    setCalibrationStatus('四个点信息已齐全，点击“标定完成”进入操作台', 'ready');
  } else {
    setCalibrationStatus('机械臂坐标输入和图像标定不分先后，每次完成后都会同步到后端');
  }
}

function renderTargetList(targets) {
  const list = document.getElementById('target-list');
  if (!targets || targets.length === 0) {
    list.innerHTML = '<div style="color:#888; padding:8px;">未检测到目标</div>';
    if (selectedTrackId === null) {
      document.getElementById('grasp-btn').disabled = true;
    }
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

  if (selectedTrackId !== null) {
    setStatus('已锁定: #' + selectedTrackId + ' ' + (data.selection_class_name || ''), 'locked');
    document.getElementById('grasp-btn').disabled = false;
  } else if (prevSelected !== null) {
    setStatus('目标丢失', 'lost');
    document.getElementById('grasp-btn').disabled = true;
  } else {
    setStatus('标定完成，检测中...', 'ready');
    document.getElementById('grasp-btn').disabled = true;
  }
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
      switchMode('calibration');
      document.getElementById('grasp-btn').disabled = true;
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

    const data = await postJSON('/api/calibration/point', {
      point_index: index,
      robot_x: robotX,
      robot_y: robotY
    });

    renderCalibrationState(data.calibration);
    const pointName = CALIBRATION_POINT_NAMES[index];
    const currentPoint = normalizeCalibrationState(data.calibration).points[index];
    if (currentPoint.ready) {
      setCalibrationStatus(`${pointName}机械臂坐标已记录，当前点数据已完整同步到后端`, 'ready');
    }
    return true;
  } catch (err) {
    console.error('[HTTP] 保存机械臂坐标失败', err);
    setCalibrationStatus('保存机械臂坐标失败: ' + err.message, 'lost');
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

  let renderWidth, renderHeight, offsetX, offsetY;

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
    setCalibrationStatus('保存图像坐标失败: ' + err.message, 'lost');
  }
}

async function completeCalibration() {
  try {
    const data = await postJSON('/api/calibration/complete', {});
    activeCalibrationPoint = null;
    renderCalibrationState(data.calibration);
    switchMode('operate');
    setStatus('标定完成，请点击画面或右侧列表选择目标', 'ready');
    await fetchState();
  } catch (err) {
    console.error('[HTTP] 完成标定失败', err);
    setCalibrationStatus('完成标定失败: ' + err.message, 'lost');
  }
}

async function selectTarget(trackId) {
  try {
    const data = await postJSON('/api/select', { track_id: trackId });
    selectedTrackId = data.track_id;
    setStatus('已锁定: #' + data.track_id + ' ' + (data.class_name || ''), 'locked');
    document.getElementById('grasp-btn').disabled = false;
    await fetchState();
  } catch (err) {
    console.error('[HTTP] 选择目标失败', err);
    setStatus('选择目标失败: ' + err.message, 'lost');
  }
}

async function onOperationImageClick(event) {
  try {
    const { normX, normY } = getImagePoint(event);

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
      click_x_norm: Math.round(normX * 10000) / 10000,
      click_y_norm: Math.round(normY * 10000) / 10000
    });

    if (data.track_id !== undefined) {
      selectedTrackId = data.track_id;
      setStatus('已锁定: #' + data.track_id + ' ' + (data.class_name || ''), 'locked');
      document.getElementById('grasp-btn').disabled = false;
    }
    await fetchState();
  } catch (err) {
    console.error('[HTTP] 点击选择失败', err);
    setStatus('未选中任何目标', 'lost');
  }
}

async function sendGrasp() {
  if (selectedTrackId === null) return;
  document.getElementById('grasp-btn').disabled = true;
  setStatus('正在计算抓取坐标...', 'warning');

  try {
    const data = await postJSON('/api/grasp', { track_id: selectedTrackId });
    if (data.success) {
      setStatus(`抓取坐标已生成: X=${data.target_x}, Y=${data.target_y}, Z=${data.target_z}`, 'locked');
    } else {
      setStatus('抓取失败: ' + (data.reason || 'unknown'), 'lost');
    }
  } catch (err) {
    console.error('[HTTP] 抓取失败', err);
    setStatus('抓取失败: ' + err.message, 'lost');
  } finally {
    document.getElementById('grasp-btn').disabled = selectedTrackId === null;
  }
}

function startPolling() {
  if (pollingTimer) clearInterval(pollingTimer);
  fetchState();
  pollingTimer = setInterval(fetchState, 250);
}

switchMode('calibration');
startPolling();
