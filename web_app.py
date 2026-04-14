import gevent
from flask import Flask, Response, jsonify, render_template, request

from shared_state import (
    clear_selection,
    find_nearest_target,
    get_state_payload,
    grasp_target,
    select_target,
)


def create_app(state):
    app = Flask(__name__)

    @app.route('/')
    def index():
        return render_template('index.html')

    @app.route('/video')
    def video():
        def generate():
            last_frame_id = 0
            while True:
                with state.lock:
                    jpeg = state.latest_jpeg
                    frame_id = state.latest_frame_id
                if jpeg is not None and frame_id != last_frame_id:
                    last_frame_id = frame_id
                    yield (
                        b'--frame\r\n'
                        b'Content-Type: image/jpeg\r\n\r\n' + jpeg + b'\r\n'
                    )
                else:
                    gevent.sleep(0.01)

        return Response(generate(), mimetype='multipart/x-mixed-replace; boundary=frame')

    @app.route('/api/state')
    def api_state():
        return jsonify(get_state_payload(state))

    @app.route('/api/select', methods=['POST'])
    def api_select():
        data = request.get_json(silent=True) or {}
        track_id = data.get('track_id')
        if track_id is None:
            return jsonify({"ok": False, "reason": "missing_track_id"}), 400

        result = select_target(state, track_id)
        return jsonify(result), 200 if result.get('ok') else 404

    @app.route('/api/click', methods=['POST'])
    def api_click():
        data = request.get_json(silent=True) or {}
        click_x = data.get('click_x_norm')
        click_y = data.get('click_y_norm')
        if click_x is None or click_y is None:
            return jsonify({"ok": False, "reason": "missing_click_point"}), 400

        print(f"[HTTP] 点击坐标: x={click_x}, y={click_y}")
        best = find_nearest_target(state, click_x, click_y)
        if best is None:
            print("[HTTP]   -> 附近没有目标")
            return jsonify({"ok": False, "reason": "target_not_found"}), 404

        print(f"[HTTP]   -> 匹配到目标: #{best['track_id']} {best['class_name']}")
        result = select_target(state, best['track_id'])
        return jsonify(result), 200 if result.get('ok') else 404

    @app.route('/api/grasp', methods=['POST'])
    def api_grasp():
        data = request.get_json(silent=True) or {}
        track_id = data.get('track_id')
        if track_id is None:
            return jsonify({"ok": False, "reason": "missing_track_id"}), 400

        result = grasp_target(state, track_id)
        return jsonify(result), 200 if result.get('success') else 404

    @app.route('/api/deselect', methods=['POST'])
    def api_deselect():
        print("[HTTP] 取消选择")
        with state.lock:
            clear_selection(state)
        return jsonify({"ok": True})

    return app
