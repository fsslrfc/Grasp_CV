import torch

print('CUDA 是否可用:', torch.cuda.is_available())
print('当前使用的 CUDA 版本:', torch.version.cuda)
print('显卡型号:', torch.cuda.get_device_name(0))

##########
##########

from ultralytics import YOLO
import cv2
import time

def run_vision(input_image_name='test.png'):
    print("正在加载 YOLOv8 模型...")
    # 第一次运行会自动下载 yolov8n.pt 权重文件（大概 6MB，非常轻量）
    model = YOLO('yolov8n.pt')

    print(f"正在对 {input_image_name} 进行目标检测...")
    start_time = time.time()
    # 参数说明：
    # source: 输入的图片路径
    # save=True: 保存画好框的图片
    # conf=0.5: 置信度阈值，低于 50% 把握的物体不要
    results = model(
        source=f'C:/A_Projects/Python/Grasp/{input_image_name}',
        save=True,
        conf=0.5,
        project='C:/A_Projects/Python/Grasp/',
        name='results',
        exist_ok=True)

    end_time = time.time()

    # 遍历检测结果（因为可能检测到多个物体）
    for result in results:
        boxes = result.boxes  # 获取所有检测框

        # 遍历每一个框
        for box in boxes:
            # 1. 获取类别 ID 和名称
            class_id = int(box.cls[0])
            class_name = model.names[class_id]

            # 2. 获取置信度
            confidence = float(box.conf[0])

            # 3. 获取中心点坐标 (x, y) 和 宽高 (w, h)
            # xywh 返回的是中心点坐标，如果是 xyxy 返回的是左上和右下角坐标
            x, y, w, h = box.xywh[0].tolist()

            # 打印出你毕设最需要的数据
            print(f"找到目标: [{class_name}] (把握: {confidence:.2f})")
            print(f"   图像像素坐标: X={x:.1f}, Y={y:.1f}")
            print("-" * 30)

    print(f"检测完成！画好框的图片已保存在 results 文件夹下，耗时 {end_time - start_time:.2f} 秒")

if __name__ == '__main__':
    run_vision()