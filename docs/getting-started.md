# Run your first experiment

Start with S1, a small plaza-and-tunnel experiment. You will run feedback OFF and ON, calculate their metrics, and open a figure. The prepared inputs come with the repository.

For a description of the model, read the [README](../README.md). This guide assumes you have not used these scripts before.

## 1. Open the project directory

Download and extract the repository ZIP, or clone the repository. Open the directory containing `run.py`, `requirements.txt` and `README.md`.

On Windows, click the File Explorer address bar, type `powershell` and press Enter. This opens PowerShell in that directory. If you use Anaconda, you can instead open Anaconda Prompt and change to the extracted directory.

All commands below run from the project directory. Typing them from its parent is a common cause of “can't open file run.py”.

## 2. Check Python and Node

```bash
python --version
node --version
```

Use Python 3.11 or later and Node.js 20 or later. The release was checked with Python 3.11.8 and Node.js 24.19.0. Their roles are different: Python starts jobs and reads results; the Node process computes each person's movement.

If either command is unavailable, install that runtime through your usual environment manager and reopen the terminal. The repository does not install system software. A GPU is not needed.

You can use an existing Python environment. To keep the dependencies separate, create a virtual environment:

```bash
python -m venv .venv
```

In Windows PowerShell, activate it with:

```powershell
.\.venv\Scripts\Activate.ps1
```

In a macOS or Linux shell:

```bash
source .venv/bin/activate
```

If Windows blocks the activation script, use the environment's interpreter directly, without changing system policy:

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

In that case, replace `python` in subsequent commands with `.\.venv\Scripts\python.exe`.

## 3. Install the Python dependencies

```bash
python -m pip install -r requirements.txt
python verify_package.py
```

The package check should report `0 differences`. It compares the distributed files with their saved hashes. A hash is a fingerprint of a file's bytes; this check catches incomplete downloads and accidental edits.

If Node is installed but is not on PATH, supply its executable explicitly. For example, with Node installed in the standard Windows location:

```powershell
python run.py bottleneck --inflows 6 --seeds 1 --node "C:\Program Files\nodejs\node.exe" --output outputs/s1_demo
```

That command already runs the example. Use the actual location of your `node.exe` if it differs, then continue at step 5. The alternative `NODE_BINARY` environment variable also supplies the executable.

## 4. Run S1

```bash
python run.py bottleneck --inflows 6 --seeds 1 --output outputs/s1_demo
```

The run starts with `Jobs: 2`: one OFF case and one ON case. Inflow 6 is six agents per model second for this controlled experiment. Seed 1 fixes the random choices so both conditions receive matching demand.

The first job runs before the remaining jobs so the launcher can measure its memory use. This is expected; the program has not lost the parallel setting.

A successful run ends with `Verified 2/2 completed results`. Its output contains:

```text
outputs/s1_demo/
  batch.json
  logs/
  runs/
    s1_rate_6__feedback_off__seed01.json
    s1_rate_6__feedback_off__seed01.json.receipt.json
    s1_rate_6__feedback_on__seed01.json
    s1_rate_6__feedback_on__seed01.json.receipt.json
```

The run JSON stores movement states, crossings and measurements. A receipt records its checksum and completion status. `batch.json` records which jobs and inputs belong to this batch.

## 5. Calculate the metrics

```bash
python evaluate.py --experiment bottleneck --runs outputs/s1_demo --output outputs/s1_demo_eval
```

Open `outputs/s1_demo_eval/figure_data/run_summary.csv` in a spreadsheet viewer. It has one row per run. Look for completion time, peak gate-front count and peak five-second exit flux.

Evaluation reads saved runs; it does not move the agents again. Its manifest records the source files used to produce the tables.

## 6. Draw the figure

```bash
python render.py --evaluation outputs/s1_demo_eval --output outputs/s1_demo_figures
```

Open `outputs/s1_demo_figures/bottleneck_metrics.png`. A PDF is saved beside it. There is only one inflow level in this example, so each panel has one point per condition. A figure with all four inflows requires the [full S1 experiment](reproduction.md#reproduce-the-bottleneck-experiment).

One seed does not provide a sample standard deviation or paired confidence interval. Empty interval fields are expected here. The [results guide](results.md) explains the full-study comparisons.

## Use the notebook

If you prefer cells to terminal commands:

```bash
python -m pip install -r requirements-notebook.txt
jupyter lab
```

Open `quickstart.ipynb` from the JupyterLab file browser and run the cells in order. It uses timestamped output directories and runs the same S1 simulation, evaluation and rendering commands.

## Common errors

| Message or symptom | Cause | Action |
|---|---|---|
| `python` or `node` is not recognized | The runtime is absent from the current terminal's PATH | Open the correct environment, reopen the terminal after installation, or supply `--node` |
| `ModuleNotFoundError` | Dependencies were installed into a different Python environment | Run `python -m pip install -r requirements.txt` with the interpreter that will run the project |
| `Output already exists` | The output name was used before | Choose a new directory; for an interrupted simulation, use the [resume procedure](reproduction.md#resume-an-interrupted-batch) |
| `Result checksum mismatch` | A saved run differs from its receipt | Keep that batch for inspection and run into a new directory |
| `Incomplete result` | A run file or its receipt is missing | Keep the incomplete batch and use a new output directory |
| `Another launcher is using ...` | Two launchers are writing to the same batch | Let the active launcher finish or choose a different output directory |
| No MP4 appears | FFmpeg was unavailable | Stadium animation falls back to GIF; S1 rendering produces static metrics |

After S1 works, use the [one-tunnel example](../README.md#run-the-stadium-experiment) before starting the 120-run study.
