import time
import threading

import cv2
from ultralytics import YOLO

from shared_state import clear_selection


class VisionWorker(threading.Thread):
    def __init__(
        self,
        state,
        model_path='yolov8n.pt',
        camera_id=0,
        target_fps=15,
        jpeg_quality=75,
        resolution=(640, 480),
        lost_threshold=5,
        capture_backend=cv2.CAP_DSHOW,
    ):
        super().__init__(daemon=True)
        self.state = state
        self.model_path = model_path
        self.camera_id = camera_id
        self.target_fps = target_fps
        self.jpeg_quality = jpeg_quality
        self.resolution = resolution
        self.lost_threshold = lost_threshold
        self.capture_backend = capture_backend
        self.running = True

    def run(self):
        print("[VisionWorker] 正在加载 YOLOv8 模型...")
        model = YOLO(self.model_path)
        print("[VisionWorker] 模型加载完毕！")

        cap = self._open_capture()
        if not cap.isOpened():
            print("[VisionWorker] 无法打开摄像头！")
            return

        self._configure_capture(cap)
        print(f"[VisionWorker] 摄像头已开启 ({self.resolution[0]}x{self.resolution[1]})")
        print(f"[VisionWorker] 目标帧率: {self.target_fps} FPS, JPEG质量: {self.jpeg_quality}")

        frame_interval = 1.0 / self.target_fps
        while self.running:
            start_time = time.time()
            success, frame = cap.read()
            if not success:
                print("[VisionWorker] 读取画面失败！")
                time.sleep(0.1)
                continue

            result = model.track(source=frame, conf=0.5, verbose=False, persist=True)[0]
            height, width = frame.shape[:2]
            targets = self._extract_targets(result, model.names, width, height)

            self._draw_targets(frame, targets, width, height)
            self._sync_selection(frame, targets, width, height)
            self._draw_calibration_points(frame)

            encoded, jpeg = cv2.imencode(
                '.jpg',
                frame,
                [int(cv2.IMWRITE_JPEG_QUALITY), self.jpeg_quality],
            )
            if not encoded:
                continue

            with self.state.lock:
                self.state.latest_frame_id += 1
                self.state.latest_jpeg = jpeg.tobytes()
                self.state.latest_targets = targets
                self.state.image_width = width
                self.state.image_height = height

            wait_time = frame_interval - (time.time() - start_time)
            if wait_time > 0:
                time.sleep(wait_time)

        cap.release()
        print("[VisionWorker] 已停止")

    def stop(self):
        self.running = False

    def _open_capture(self):
        if self.capture_backend is None:
            return cv2.VideoCapture(self.camera_id)
        return cv2.VideoCapture(self.camera_id, self.capture_backend)

    def _configure_capture(self, cap):
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.resolution[0])
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.resolution[1])
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

    def _extract_targets(self, result, class_names, width, height):
        targets = []
        for index, box in enumerate(result.boxes):
            class_id = int(box.cls[0])
            confidence = float(box.conf[0])
            class_name = class_names[class_id]

            xywh = box.xywh[0].tolist()
            xyxy = box.xyxy[0].tolist()
            track_id = int(box.id[0]) if box.id is not None else index + 1

            targets.append({
                "track_id": track_id,
                "class_name": class_name,
                "confidence": round(confidence, 2),
                "center_norm": [round(xywh[0] / width, 4), round(xywh[1] / height, 4)],
                "bbox_norm": [round(xyxy[0] / width, 4), round(xyxy[1] / height, 4), round(xyxy[2] / width, 4), round(xyxy[3] / height, 4)],
            })
        return targets

    def _draw_targets(self, frame, targets, width, height):
        for target in targets:
            x1 = int(target["bbox_norm"][0] * width)
            y1 = int(target["bbox_norm"][1] * height)
            x2 = int(target["bbox_norm"][2] * width)
            y2 = int(target["bbox_norm"][3] * height)

            cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
            cv2.putText(
                frame,
                f"#{target['track_id']} {target['class_name']} {target['confidence']:.0%}",
                (x1, y1 - 8),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.5,
                (0, 255, 0),
                2,
            )

    def _sync_selection(self, frame, targets, width, height):
        with self.state.lock:
            selected_id = self.state.selected_track_id

        if selected_id is None:
            return

        selected_target = next((target for target in targets if target["track_id"] == selected_id), None)
        if selected_target is None:
            with self.state.lock:
                self.state.selected_missing_frames += 1
                if self.state.selected_missing_frames >= self.lost_threshold:
                    print(f"[VisionWorker] 目标 #{selected_id} 连续 {self.lost_threshold} 帧丢失，自动失锁")
                    clear_selection(self.state)
            return

        with self.state.lock:
            self.state.selected_missing_frames = 0

        x1 = int(selected_target["bbox_norm"][0] * width)
        y1 = int(selected_target["bbox_norm"][1] * height)
        x2 = int(selected_target["bbox_norm"][2] * width)
        y2 = int(selected_target["bbox_norm"][3] * height)
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 255), 3)
        cv2.putText(
            frame,
            "SELECTED",
            (x1, y1 - 28),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.7,
            (0, 255, 255),
            2,
        )

    def _draw_calibration_points(self, frame):
        with self.state.lock:
            points = [tuple(point) for point in self.state.calibration_pixel_points]
            confirmed = self.state.calibration_confirmed

        color = (255, 0, 0) if confirmed else (0, 0, 255)
        labels = ["LT", "RT", "RB", "LB"]
        valid_points = []

        for point in points:
            px, py = point
            if px is None or py is None:
                valid_points.append(None)
            else:
                valid_points.append((int(px), int(py)))

        ordered_edges = [(0, 1), (1, 2), (2, 3), (3, 0)]
        for start_index, end_index in ordered_edges:
            start_point = valid_points[start_index]
            end_point = valid_points[end_index]
            if start_point is None or end_point is None:
                continue
            cv2.line(frame, start_point, end_point, color, 2)

        for index, point in enumerate(valid_points):
            if point is None:
                continue

            px, py = point
            cv2.circle(frame, (px, py), 6, color, -1)
            cv2.circle(frame, (px, py), 12, color, 2)
            cv2.putText(
                frame,
                labels[index],
                (px + 10, py - 10),
                cv2.FONT_HERSHEY_SIMPLEX,
                0.6,
                color,
                2,
            )
