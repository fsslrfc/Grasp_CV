import gevent
from flask import Flask, Response, jsonify, render_template, request

from shared_state import (
    finalize_calibration,
    find_nearest_target,
    get_state_payload,
    grasp_target,
    is_operation_ready,
    place_point,
    select_target,
    update_calibration_point,
)


def create_app(state):
    app = Flask(__name__)

    def calibration_required_response():
        return jsonify({"ok": False, "reason": "calibration_required"}), 400

    def operation_result_status(result):
        if result.get("ok") or result.get("success"):
            return 200
        if result.get("reason") in {"target_not_found", "target_lost"}:
            return 404
        return 400

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

    @app.route('/api/calibration/point', methods=['POST'])
    def api_calibration_point():
        data = request.get_json(silent=True) or {}
        point_index = data.get('point_index')
        if point_index is None:
            return jsonify({"ok": False, "reason": "missing_point_index"}), 400

        kwargs = {"point_index": point_index}
        for field in ('robot_x', 'robot_y', 'pixel_x', 'pixel_y'):
            if field in data:
                kwargs[field] = data.get(field)

        result = update_calibration_point(state, **kwargs)
        return jsonify(result), 200 if result.get('ok') else 400

    @app.route('/api/calibration/complete', methods=['POST'])
    def api_calibration_complete():
        result = finalize_calibration(state)
        return jsonify(result), 200 if result.get('ok') else 400

    @app.route('/api/select', methods=['POST'])
    def api_select():
        if not is_operation_ready(state):
            return calibration_required_response()

        data = request.get_json(silent=True) or {}
        track_id = data.get('track_id')
        if track_id is None:
            return jsonify({"ok": False, "reason": "missing_track_id"}), 400

        result = select_target(state, track_id)
        return jsonify(result), 200 if result.get('ok') else 404

    @app.route('/api/click', methods=['POST'])
    def api_click():
        if not is_operation_ready(state):
            return calibration_required_response()

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
        if not is_operation_ready(state):
            return calibration_required_response()

        data = request.get_json(silent=True) or {}
        track_id = data.get('track_id')
        if track_id is None:
            return jsonify({"ok": False, "reason": "missing_track_id"}), 400

        result = grasp_target(state, track_id)
        return jsonify(result), operation_result_status(result)

    @app.route('/api/place', methods=['POST'])
    def api_place():
        if not is_operation_ready(state):
            return calibration_required_response()

        data = request.get_json(silent=True) or {}
        click_x = data.get('click_x_norm')
        click_y = data.get('click_y_norm')
        if click_x is None or click_y is None:
            return jsonify({"ok": False, "reason": "missing_click_point"}), 400

        result = place_point(state, click_x, click_y)
        return jsonify(result), operation_result_status(result)

    return app
