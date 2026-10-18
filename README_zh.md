# 体育场散场模拟：复现说明

这是论文 **Video-Driven Agent-Based Simulation of Stadium Egress** 的整理版代码。主实验是六个通道 A–F 的整场连续模拟，另有 S1 瓶颈实验和 MOT20 短时辅助检查。

入口只有几个：`prepare.py` 准备数据，`run.py` 运行，`evaluate.py` 算指标，`render.py` 画图和生成总览动画。原来的实验记录、旧结果和论文文件保留在原项目中。

## 先跑一个小例子

需要 Python 3.11 以上和 Node.js 20 以上。先在代码目录打开终端：

```bash
python -m pip install -r requirements.txt
python run.py bottleneck --inflows 6 --seeds 1 --output outputs/s1_demo
python evaluate.py --experiment bottleneck --runs outputs/s1_demo --output outputs/s1_demo_eval
python render.py --evaluation outputs/s1_demo_eval --output outputs/s1_demo_figures
```

这会运行 S1 的一个开/关配对案例，得到 JSON、CSV 和图片。也可以打开 `quickstart.ipynb` 按单元格执行。

如果系统找不到 Node，在 `run.py` 的命令最后加 `--node "你的 node.exe 路径"`。模拟使用 CPU；不调用显卡。

## 跑整场六通道

```bash
python run.py stadium --full --workers 22 --output outputs/stadium_full
python evaluate.py --runs outputs/stadium_full --data data/stadium --output outputs/stadium_eval
python render.py --evaluation outputs/stadium_eval --output outputs/stadium_figures --animate
```

处理好的六通道输入已放在 `data/stadium/`，这一步不需要重新检测视频。完整实验共 120 次运行，原始结果约 3.3 GB。并行数会按实际可用内存下调。原实验使用 22 个 CPU 进程，记录的批处理耗时为 20.2 分钟，换机器后时间会有变化。

输出目录不能与已有目录重名。续跑时重复原命令并加 `--resume`，程序核对已完成文件后继续。换参数或改数值代码时应使用新目录。

## 这里保留了什么

- 四个核心引擎保持原始字节和哈希。
- 六通道的 ROI、口线、墙、到达和速度规则。
- 开关配对、随机种子、压力启动比例和数值检查。
- 区域人数、口前人数、过线、阶段指标与输入覆盖率。
- S1 的最终步长 0.01 model s，以及参考结果。
- 从原始 tracker CSV 重新生成输入的入口。

`reference/` 是核对结果用的表格，`docs/` 解释单位、数据格式和复现步骤。`stadium-macro-engine.js` 是沿用的文件名，里面仍然是逐个行人运动的微观模型。

英文 [README](README.md) 可直接给合作者阅读；具体测试和复现记录见 `reference/release_verification.json`。
