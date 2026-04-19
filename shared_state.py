import copy
import threading

import cv2
import numpy as np

_UNSET = object()
_CALIBRATION_GEOMETRY_ORDER = (0, 1, 3, 2)


class SharedState:
    def __init__(self):
        self.lock = threading.Lock()
        self.latest_jpeg = None
        self.latest_targets = []
        self.latest_frame_id = 0
        self.image_width = 0
        self.image_height = 0
        self.selected_track_id = None
        self.selection_class_name = None
        self.selection_center_norm = None
        self.selected_missing_frames = 0

        self.calibration_pixel_points = [[None, None] for _ in range(4)]
        self.calibration_robot_points = [[None, None, None] for _ in range(4)]
        self.calibration_confirmed = False
        self.calibration_matrix = None
        self.calibration_plane_z = None


def clear_selection(state):
    state.selected_track_id = None
    state.selection_class_name = None
    state.selection_center_norm = None
    state.selected_missing_frames = 0


def _build_calibration_payload_locked(state):
    points = []
    for index in range(4):
        pixel = copy.deepcopy(state.calibration_pixel_points[index])
        robot = copy.deepcopy(state.calibration_robot_points[index])
        pixel_ready = all(value is not None for value in pixel)
        robot_ready = all(value is not None for value in robot)
        ready = pixel_ready and robot_ready
        points.append({
            "index": index,
            "pixel": pixel,
            "robot": robot,
            "pixel_ready": pixel_ready,
            "robot_ready": robot_ready,
            "ready": ready,
        })

    return {
        "confirmed": state.calibration_confirmed and state.calibration_matrix is not None and state.calibration_plane_z is not None,
        "ready": all(point["ready"] for point in points),
        "plane_z": None if state.calibration_plane_z is None else round(float(state.calibration_plane_z), 2),
        "points": points,
    }


def _get_operation_snapshot_locked(state):
    return {
        "width": state.image_width,
        "height": state.image_height,
        "matrix": None if state.calibration_matrix is None else state.calibration_matrix.copy(),
        "plane_z": state.calibration_plane_z,
        "operation_ready": state.calibration_confirmed and state.calibration_matrix is not None and state.calibration_plane_z is not None,
        "workspace_pixel_points": copy.deepcopy(state.calibration_pixel_points),
    }


def _get_geometry_ordered_points(points):
    return [points[index] for index in _CALIBRATION_GEOMETRY_ORDER]


def _is_point_inside_workspace(pixel_points, pixel_x, pixel_y):
    if len(pixel_points) != 4:
        return False

    ordered_points = _get_geometry_ordered_points(pixel_points)
    if any(point[0] is None or point[1] is None for point in ordered_points):
        return False

    contour = np.array(ordered_points, dtype=np.float32).reshape((-1, 1, 2))
    return cv2.pointPolygonTest(contour, (float(pixel_x), float(pixel_y)), False) >= 0


def get_state_payload(state):
    with state.lock:
        selected_id = state.selected_track_id
        targets_snapshot = copy.deepcopy(state.latest_targets)
        for target in targets_snapshot:
            target["is_selected"] = target["track_id"] == selected_id
        return {
            "ok": True,
            "frame_id": state.latest_frame_id,
            "targets": targets_snapshot,
            "image_width": state.image_width,
            "image_height": state.image_height,
            "selected_track_id": selected_id,
            "selection_class_name": state.selection_class_name,
            "selection_center_norm": state.selection_center_norm,
            "calibration": _build_calibration_payload_locked(state),
        }


def select_target(state, track_id):
    print(f"[选择目标] track_id={track_id}")
    with state.lock:
        matched = next((target for target in state.latest_targets if target["track_id"] == track_id), None)
        if matched is None:
            return {"ok": False, "reason": "target_not_found", "track_id": track_id}

        state.selected_track_id = track_id
        state.selected_missing_frames = 0
        state.selection_class_name = matched["class_name"]
        state.selection_center_norm = matched["center_norm"]

        return {
            "ok": True,
            "type": "selection_confirmed",
            "track_id": track_id,
            "class_name": state.selection_class_name,
            "center_norm": state.selection_center_norm,
        }


def _coerce_float(value, field_name):
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        raise ValueError(field_name)


def _coerce_int(value, field_name):
    if value in (None, ""):
        return None
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        raise ValueError(field_name)


def update_calibration_point(
    state,
    point_index,
    robot_x=_UNSET,
    robot_y=_UNSET,
    robot_z=_UNSET,
    pixel_x=_UNSET,
    pixel_y=_UNSET,
):
    try:
        point_index = int(point_index)
    except (TypeError, ValueError):
        return {"ok": False, "reason": "invalid_point_index"}

    if point_index < 0 or point_index >= 4:
        return {"ok": False, "reason": "invalid_point_index"}

    try:
        with state.lock:
            has_update = False

            if robot_x is not _UNSET:
                state.calibration_robot_points[point_index][0] = _coerce_float(robot_x, "invalid_robot_x")
                has_update = True
            if robot_y is not _UNSET:
                state.calibration_robot_points[point_index][1] = _coerce_float(robot_y, "invalid_robot_y")
                has_update = True
            if robot_z is not _UNSET:
                state.calibration_robot_points[point_index][2] = _coerce_float(robot_z, "invalid_robot_z")
                has_update = True
            if pixel_x is not _UNSET:
                state.calibration_pixel_points[point_index][0] = _coerce_int(pixel_x, "invalid_pixel_x")
                has_update = True
            if pixel_y is not _UNSET:
                state.calibration_pixel_points[point_index][1] = _coerce_int(pixel_y, "invalid_pixel_y")
                has_update = True

            if has_update:
                state.calibration_confirmed = False
                state.calibration_matrix = None
                state.calibration_plane_z = None

            calibration = _build_calibration_payload_locked(state)

        return {
            "ok": True,
            "point_index": point_index,
            "calibration": calibration,
        }
    except ValueError as exc:
        return {"ok": False, "reason": str(exc)}


def finalize_calibration(state):
    with state.lock:
        calibration = _build_calibration_payload_locked(state)
        if not calibration["ready"]:
            return {
                "ok": False,
                "reason": "calibration_points_incomplete",
                "calibration": calibration,
            }

        src = np.float32(_get_geometry_ordered_points(state.calibration_pixel_points))
        ordered_robot_points = _get_geometry_ordered_points(state.calibration_robot_points)
        dst = np.float32([point[:2] for point in ordered_robot_points])

        if abs(cv2.contourArea(src)) < 1.0 or abs(cv2.contourArea(dst)) < 1e-3:
            return {
                "ok": False,
                "reason": "degenerate_calibration_points",
                "calibration": calibration,
            }

        try:
            state.calibration_matrix = cv2.getPerspectiveTransform(src, dst)
        except cv2.error:
            return {
                "ok": False,
                "reason": "calibration_matrix_failed",
                "calibration": calibration,
            }

        state.calibration_plane_z = float(np.mean([point[2] for point in state.calibration_robot_points]))
        state.calibration_confirmed = True
        calibration = _build_calibration_payload_locked(state)

    return {
        "ok": True,
        "type": "calibration_completed",
        "calibration": calibration,
    }


def reopen_calibration(state):
    with state.lock:
        clear_selection(state)
        state.calibration_confirmed = False
        state.calibration_matrix = None
        state.calibration_plane_z = None
        calibration = _build_calibration_payload_locked(state)

    return {
        "ok": True,
        "type": "calibration_reopened",
        "calibration": calibration,
    }


def is_operation_ready(state):
    with state.lock:
        return state.calibration_confirmed and state.calibration_matrix is not None and state.calibration_plane_z is not None


def _transform_pixel_with_matrix(matrix, pixel_x, pixel_y):
    points = np.array([[[float(pixel_x), float(pixel_y)]]], dtype=np.float32)
    transformed = cv2.perspectiveTransform(points, matrix)
    return float(transformed[0][0][0]), float(transformed[0][0][1])


def grasp_target(state, track_id):
    print(f"\n{'=' * 40}")
    print(f"[抓取指令] track_id={track_id}")

    with state.lock:
        target = next((copy.deepcopy(item) for item in state.latest_targets if item["track_id"] == track_id), None)
        snapshot = _get_operation_snapshot_locked(state)

    width = snapshot["width"]
    height = snapshot["height"]
    matrix = snapshot["matrix"]
    plane_z = snapshot["plane_z"]
    operation_ready = snapshot["operation_ready"]

    if target is None:
        print("  目标已丢失！")
        print(f"{'=' * 40}\n")
        return {
            "ok": False,
            "type": "grasp_result",
            "option": "grasp",
            "success": False,
            "track_id": track_id,
            "reason": "target_lost",
        }

    if not operation_ready:
        print("  尚未完成标定！")
        print(f"{'=' * 40}\n")
        return {
            "ok": False,
            "type": "grasp_result",
            "option": "grasp",
            "success": False,
            "track_id": track_id,
            "reason": "calibration_required",
        }

    if width <= 0 or height <= 0:
        print("  图像尺寸尚未就绪！")
        print(f"{'=' * 40}\n")
        return {
            "ok": False,
            "type": "grasp_result",
            "option": "grasp",
            "success": False,
            "track_id": track_id,
            "reason": "image_not_ready",
        }

    pixel_x = target["center_norm"][0] * width
    pixel_y = target["center_norm"][1] * height
    target_x, target_y = _transform_pixel_with_matrix(matrix, pixel_x, pixel_y)

    print(f"  目标: {target['class_name']}")
    print(f"  抓取中心(归一化): {target['center_norm']}")
    print(f"  像素坐标: ({pixel_x:.1f}, {pixel_y:.1f})")
    print(f"  物理坐标: ({target_x:.2f}, {target_y:.2f}, {plane_z:.2f})")
    print(f"{'=' * 40}\n")
    return {
        "ok": True,
        "type": "grasp_result",
        "option": "grasp",
        "success": True,
        "track_id": track_id,
        "class_name": target["class_name"],
        "center_norm": target["center_norm"],
        "pixel_x": round(float(pixel_x), 2),
        "pixel_y": round(float(pixel_y), 2),
        "target_x": round(float(target_x), 2),
        "target_y": round(float(target_y), 2),
        "target_z": round(float(plane_z), 2),
    }


def place_point(state, click_x_norm, click_y_norm):
    print(f"\n{'=' * 40}")
    print(f"[放置指令] click=({click_x_norm}, {click_y_norm})")

    try:
        click_x_norm = float(click_x_norm)
        click_y_norm = float(click_y_norm)
    except (TypeError, ValueError):
        print("  点击坐标无效！")
        print(f"{'=' * 40}\n")
        return {
            "ok": False,
            "type": "place_result",
            "option": "place",
            "success": False,
            "reason": "invalid_click_point",
        }

    with state.lock:
        snapshot = _get_operation_snapshot_locked(state)

    width = snapshot["width"]
    height = snapshot["height"]
    matrix = snapshot["matrix"]
    plane_z = snapshot["plane_z"]
    operation_ready = snapshot["operation_ready"]
    workspace_pixel_points = snapshot["workspace_pixel_points"]

    if not operation_ready:
        print("  尚未完成标定！")
        print(f"{'=' * 40}\n")
        return {
            "ok": False,
            "type": "place_result",
            "option": "place",
            "success": False,
            "reason": "calibration_required",
        }

    if width <= 0 or height <= 0:
        print("  图像尺寸尚未就绪！")
        print(f"{'=' * 40}\n")
        return {
            "ok": False,
            "type": "place_result",
            "option": "place",
            "success": False,
            "reason": "image_not_ready",
        }

    if not (0.0 <= click_x_norm <= 1.0 and 0.0 <= click_y_norm <= 1.0):
        print("  点击点超出图像范围！")
        print(f"{'=' * 40}\n")
        return {
            "ok": False,
            "type": "place_result",
            "option": "place",
            "success": False,
            "reason": "invalid_click_point",
        }

    pixel_x = click_x_norm * width
    pixel_y = click_y_norm * height
    if not _is_point_inside_workspace(workspace_pixel_points, pixel_x, pixel_y):
        print("  放置点不在标定区域内！")
        print(f"{'=' * 40}\n")
        return {
            "ok": False,
            "type": "place_result",
            "option": "place",
            "success": False,
            "reason": "point_out_of_workspace",
            "pixel_x": round(float(pixel_x), 2),
            "pixel_y": round(float(pixel_y), 2),
        }

    target_x, target_y = _transform_pixel_with_matrix(matrix, pixel_x, pixel_y)
    print(f"  像素坐标: ({pixel_x:.1f}, {pixel_y:.1f})")
    print(f"  物理坐标: ({target_x:.2f}, {target_y:.2f}, {plane_z:.2f})")
    print(f"{'=' * 40}\n")
    return {
        "ok": True,
        "type": "place_result",
        "option": "place",
        "success": True,
        "click_x_norm": round(float(click_x_norm), 4),
        "click_y_norm": round(float(click_y_norm), 4),
        "pixel_x": round(float(pixel_x), 2),
        "pixel_y": round(float(pixel_y), 2),
        "target_x": round(float(target_x), 2),
        "target_y": round(float(target_y), 2),
        "target_z": round(float(plane_z), 2),
    }


def find_nearest_target(state, x_norm, y_norm):
    if x_norm is None or y_norm is None:
        return None

    with state.lock:
        targets = copy.deepcopy(state.latest_targets)

    best = None
    best_dist = float('inf')
    for target in targets:
        cx, cy = target["center_norm"]
        dist = (cx - x_norm) ** 2 + (cy - y_norm) ** 2
        if dist < best_dist:
            best_dist = dist
            best = target

    if best is None:
        return None

    bw = best["bbox_norm"][2] - best["bbox_norm"][0]
    bh = best["bbox_norm"][3] - best["bbox_norm"][1]
    threshold = max(0.005, (bw * bh) * 2)
    return best if best_dist < threshold else None
