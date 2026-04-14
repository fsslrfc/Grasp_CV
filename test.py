import cv2
import time
from PIL.TiffImagePlugin import JPEGQUALITY
from ultralytics import YOLO
import base64
import socket
import threading
import json

def run_camera_vision(HOST='0.0.0.0', PORT=8888):
    print("正在加载 YOLOv8 模型...")
    model = YOLO('yolov8n.pt')
    print("模型加载完毕！")

    # 启动一个 TCP 服务器，允许端口复用，防止重启程序时报错“端口被占用
    server_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server_socket.bind((HOST, PORT))
    server_socket.listen(1)

    # 获取本机 IP，等待连接
    hostname = socket.gethostname()
    local_ip = socket.gethostbyname(hostname)
    print(f"TCP 服务器启动成功！本机 IP_Port 为: {local_ip}:{PORT}")
    conn, addr = server_socket.accept()
    print(f"客户端已连接：{addr}")

    recv_thread = threading.Thread(target=handle_client_receive, args=(conn, addr), daemon=True)
    recv_thread.start()

    # 打开摄像头 (0 代表系统默认的第一个摄像头)
    cap = cv2.VideoCapture(0)

    if not cap.isOpened():
        print("无法打开摄像头，请检查连接或权限！")
        return

    print("摄像头已开启，按键盘 'q' 键退出...")

    # 进入实时视频流循环
    while True:
        start_time = time.time()

        success, frame = cap.read()
        if not success:
            print("读取画面失败！")
            break

        # 将这一帧画面送给 YOLO 进行推理，verbose=False 可以关掉终端里每帧疯狂刷屏的提示
        result = model(source=frame, conf=0.5, verbose=False)[0]

        # 获取画好 YOLO 识别框的图像，对图像做压缩
        annotated_frame = result.plot()

        send_data = {
            "image": image_to_base64(annotated_frame),
            "list": []
        }

        # 提取识别的数据
        for i, box in enumerate(result.boxes, 1):
            class_id = int(box.cls[0])
            class_name = model.names[class_id]
            confidence = float(box.conf[0])
            x, y, w, h = box.xywh[0].tolist()

            send_data["list"].append({
                "id": i,
                "class_name": class_name,
                "x": x,
                "y": y,
                "w": w,
                "h": h
            })

        send_data = json.dumps(send_data) + '\n'
        print(send_data)
        conn.sendall(send_data.encode('utf-8'))

        # 在电脑屏幕上实时显示带框的画面
        cv2.imshow("Robot Vision (Press 'q' to quit)", annotated_frame)

        # 监听键盘事件，如果按下 'q' 键则跳出循环
        if cv2.waitKey(1) & 0xFF == ord('q'):
            break

    # 释放资源，关闭窗口
    cap.release()
    cv2.destroyAllWindows()
    conn.close()
    server_socket.close()

def handle_client_receive(conn, addr):
    """
    这是一个独立的子线程，专门用来接收 OpenHarmony 发来的坐标数据，这样就不会阻塞主线程的视频流发送
    """
    buffer = ""
    while True:
        try:
            data = conn.recv(1024).decode('utf-8')
            if not data:
                print(f"开发板 {addr} 已断开连接")
                break

            buffer += data
            # 处理粘包：以换行符划分每一条指令
            while '\n' in buffer:
                line, buffer = buffer.split('\n', 1)
                if line.strip():
                    try:
                        # 解析来自鸿蒙的 JSON 指令
                        cmd = json.loads(line)
                        if cmd.get("type") == "click_event":
                            click_x = cmd.get("x")
                            click_y = cmd.get("y")
                            print(f"\n[收到开发板指令] 用户点击了屏幕: X={click_x}, Y={click_y}")
                            # TODO: 逆运动学解算
                    except json.JSONDecodeError:
                        print("JSON 解析失败:", line)
        except Exception as e:
            print(f"接收线程异常: {e}")
            break

def image_to_base64(annotated_frame):
    _, buffer = cv2.imencode('.jpg', annotated_frame, [int(cv2.IMWRITE_JPEG_QUALITY), JPEGQUALITY])
    return base64.b64encode(buffer).decode('utf-8')

if __name__ == '__main__':
    run_camera_vision()