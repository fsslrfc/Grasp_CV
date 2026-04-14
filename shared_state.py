import copy
import threading


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


def clear_selection(state):
    state.selected_track_id = None
    state.selection_class_name = None
    state.selection_center_norm = None
    state.selected_missing_frames = 0


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


def grasp_target(state, track_id):
    print(f"\n{'=' * 40}")
    print(f"[抓取指令] track_id={track_id}")

    with state.lock:
        target = next((copy.deepcopy(item) for item in state.latest_targets if item["track_id"] == track_id), None)

    if target is None:
        print("  目标已丢失！")
        print(f"{'=' * 40}\n")
        return {
            "ok": False,
            "type": "grasp_result",
            "success": False,
            "track_id": track_id,
            "reason": "target_lost",
        }

    print(f"  目标: {target['class_name']}")
    print(f"  抓取中心(归一化): {target['center_norm']}")
    print(f"{'=' * 40}\n")
    return {
        "ok": True,
        "type": "grasp_result",
        "success": True,
        "track_id": track_id,
        "class_name": target["class_name"],
        "center_norm": target["center_norm"],
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
