import os

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import socket
import time

from gevent import pywsgi

from shared_state import SharedState
from vision_service import VisionWorker
from web_app import create_app


def wait_for_first_frame(state, timeout=5):
    print("等待视觉线程就绪...")
    deadline = time.time() + timeout
    while time.time() < deadline:
        with state.lock:
            if state.latest_jpeg is not None:
                return True
        time.sleep(0.1)
    return False


def resolve_local_ip(default_host):
    try:
        return socket.gethostbyname(socket.gethostname())
    except OSError:
        return default_host


def run_camera_vision(
    host='0.0.0.0',
    port=5000,
    camera_id=2,
    target_fps=15,
    jpeg_quality=75,
    resolution=(640, 480),
):
    state = SharedState()
    worker = VisionWorker(
        state=state,
        model_path='yolov8n.pt',
        camera_id=camera_id,
        target_fps=target_fps,
        jpeg_quality=jpeg_quality,
        resolution=resolution,
        lost_threshold=5,
    )
    worker.start()

    if not wait_for_first_frame(state):
        print("视觉线程尚未产出首帧，Web 端将等待视频流就绪...")

    local_ip = resolve_local_ip(host)
    print(f"\n服务已启动：")
    print(f"  操作界面:     http://{local_ip}:{port}/")
    print(f"  MJPEG 视频流: http://{local_ip}:{port}/video")
    print(f"  状态接口:     http://{local_ip}:{port}/api/state")
    print("=" * 50)

    app = create_app(state)
    server = pywsgi.WSGIServer((host, port), app)
    try:
        server.serve_forever()
    finally:
        worker.stop()


if __name__ == '__main__':
    run_camera_vision(
        target_fps=15,
        jpeg_quality=75,
        resolution=(640, 480),
    )
