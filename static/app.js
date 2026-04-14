let currentTargets = [];
let selectedTrackId = null;
let lastFrameId = -1;
let pollingTimer = null;

function setStatus(text, className = '') {
  const el = document.getElementById('status');
  el.textContent = text;
  el.className = className;
}

function renderTargetList(targets) {
  const list = document.getElementById('target-list');
  if (!targets || targets.length === 0) {
    list.innerHTML = '<div style="color:#888; padding:8px;">未检测到目标</div>';
    if (!selectedTrackId) document.getElementById('grasp-btn').disabled = true;
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

async function fetchState() {
  try {
    const resp = await fetch('/api/state?ts=' + Date.now(), { cache: 'no-store' });
    const data = await resp.json();

    const prevSelected = selectedTrackId;
    currentTargets = data.targets || [];
    selectedTrackId = data.selected_track_id ?? null;

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
      setStatus('已连接，检测中...');
      document.getElementById('grasp-btn').disabled = true;
    }

    lastFrameId = data.frame_id;
  } catch (err) {
    console.error('[HTTP] 获取状态失败', err);
    setStatus('状态获取失败，正在重试...', 'lost');
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

async function onImageClick(event) {
  const img = event.target;
  const rect = img.getBoundingClientRect();
  const click_x_norm = (event.clientX - rect.left) / rect.width;
  const click_y_norm = (event.clientY - rect.top) / rect.height;

  let hit = null;
  for (const t of currentTargets) {
    const [x1, y1, x2, y2] = t.bbox_norm;
    if (click_x_norm >= x1 && click_x_norm <= x2 && click_y_norm >= y1 && click_y_norm <= y2) {
      hit = t;
      break;
    }
  }

  try {
    if (hit) {
      await selectTarget(hit.track_id);
    } else {
      const data = await postJSON('/api/click', {
        click_x_norm: Math.round(click_x_norm * 10000) / 10000,
        click_y_norm: Math.round(click_y_norm * 10000) / 10000
      });
      if (data.track_id !== undefined) {
        selectedTrackId = data.track_id;
        setStatus('已锁定: #' + data.track_id + ' ' + (data.class_name || ''), 'locked');
        document.getElementById('grasp-btn').disabled = false;
      }
      await fetchState();
    }
  } catch (err) {
    console.error('[HTTP] 点击选择失败', err);
    setStatus('未选中任何目标', 'lost');
  }
}

async function sendGrasp() {
  if (selectedTrackId === null) return;
  document.getElementById('grasp-btn').disabled = true;
  setStatus('正在执行抓取...');

  try {
    const data = await postJSON('/api/grasp', { track_id: selectedTrackId });
    if (data.success) {
      setStatus('抓取指令已下发', 'locked');
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

startPolling();
