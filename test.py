import cv2
import time
import torch
from ultralytics import YOLO

def run_camera_vision():
    print("正在加载 YOLOv8 模型...")
    # 第一次运行会自动下载 yolov8n.pt 权重文件（大概 6MB，非常轻量）
    model = YOLO('yolov8n.pt')
    print("模型加载完毕！")

    # 1. 打开摄像头 (0 代表系统默认的第一个摄像头)
    # 如果你有外接 USB 摄像头，且打不开，可以尝试把 0 改成 1 或 2
    cap = cv2.VideoCapture(0)

    if not cap.isOpened():
        print("无法打开摄像头，请检查连接或权限！")
        return

    print("摄像头已开启，按键盘 'q' 键退出...")

    # 2. 进入实时视频流循环
    while True:
        # 记录每帧开始时间
        start_time = time.time()

        # 读取一帧画面
        success, frame = cap.read()
        if not success:
            print("读取画面失败！")
            break

        # 3. 将这一帧画面送给 YOLO 进行推理
        # 注意：这里去掉了 save=True，因为我们要自己用 OpenCV 显示画面
        # verbose=False 可以关掉终端里每帧疯狂刷屏的提示
        results = model(source=frame, conf=0.5, verbose=False)

        # 提取第一个结果 (因为每次只传了一张图片)
        result = results[0]

        # 4. 提取数据 (这是为你后续发送给 OpenHarmony 准备的)
        for box in result.boxes:
            class_id = int(box.cls[0])
            class_name = model.names[class_id]
            confidence = float(box.conf[0])
            x, y, w, h = box.xywh[0].tolist()

            # 在终端打印目标坐标 (这里你可以加上过滤条件，比如只打印 cup)
            # print(f"找到 [{class_name}] X={x:.1f}, Y={y:.1f}")

        # 5. 获取画好 YOLO 识别框的图像 (Ultralytics 提供的一键画图功能)
        annotated_frame = result.plot()

        # 计算并叠加 FPS (每秒帧率)
        fps = 1.0 / (time.time() - start_time)
        cv2.putText(annotated_frame, f"FPS: {fps:.1f}", (10, 30),
                    cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)

        # 6. 在电脑屏幕上实时显示带框的画面
        cv2.imshow("Robot Vision (Press 'q' to quit)", annotated_frame)

        # 7. 监听键盘事件，如果按下 'q' 键则跳出循环
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    # 8. 释放资源，关闭窗口
    cap.release()
    cv2.destroyAllWindows()

if __name__ == '__main__':
    run_camera_vision()