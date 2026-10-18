"""Plot evaluated counts and optional overview animations from saved results."""
from __future__ import annotations

import argparse
import csv
import json
import math
import shutil
from collections import defaultdict
from pathlib import Path

import numpy as np

from src.evaluation import digest


METHODS = ['observation_proxy', 'feedback_off', 'feedback_on']
COLORS = {'observation_proxy': '#666666', 'feedback_off': '#0072B2', 'feedback_on': '#D55E00'}
LABELS = {'observation_proxy': 'Tracking reference', 'feedback_off': 'feedback OFF', 'feedback_on': 'feedback ON'}
STYLES = {'observation_proxy': ':', 'feedback_off': '--', 'feedback_on': '-'}
PHASE_COLORS = ['#eeeeee', '#FAEEDA', '#FAC775', '#F0997B', '#B5D4F4', '#eeeeee']
PHASE_NAMES = {'pre-event': 'pre-event', 'a': '(a) early departures', 'b': '(b) build-up',
               'c': '(c) congestion', 'd': '(d) dispersing', 'after': 'after'}


def read_rows(path):
    def parse(value):
        if value == '':
            return None
        if value in ['True', 'False']:
            return value == 'True'
        try:
            return float(value)
        except ValueError:
            return value
    with path.open(newline='', encoding='utf-8') as stream:
        return [{key: parse(value) for key, value in row.items()} for row in csv.DictReader(stream)]


def setup_plot():
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    plt.rcParams.update({'font.family': 'serif', 'font.serif': ['Times New Roman', 'Liberation Serif', 'DejaVu Serif'],
                         'font.size': 8, 'axes.titlesize': 9, 'axes.labelsize': 8, 'legend.fontsize': 8,
                         'xtick.labelsize': 8, 'ytick.labelsize': 8,
                         'pdf.fonttype': 42, 'ps.fonttype': 42,
                         'axes.spines.top': False, 'axes.spines.right': False})
    return plt


def save_figure(fig, output, name):
    for extension in ['pdf', 'png']:
        fig.savefig(output / f'{name}.{extension}', dpi=180)


def draw_series(ax, rows, field, time='dataset_time_tV', seeds=None):
    """Align seed series by timestamp; leave missing samples as gaps."""
    for method in METHODS:
        groups = defaultdict(dict)
        for row in rows:
            if row['method'] != method:
                continue
            seed = row.get('seed')
            if method != 'observation_proxy' and seeds is not None and seed not in seeds:
                continue
            groups[seed][row[time]] = row.get(field)
        if not groups:
            continue
        times = sorted(set().union(*(set(values) for values in groups.values())))
        values = np.array([[np.nan if series.get(t) is None else series[t] for t in times]
                           for series in groups.values()], dtype=float)
        average = np.mean(values, axis=0)
        ax.plot(times, average, color=COLORS[method], linestyle=STYLES[method],
                linewidth=1.0, label=LABELS[method])
        if len(values) > 1:
            ax.fill_between(times, np.min(values, axis=0), np.max(values, axis=0),
                            color=COLORS[method], alpha=.15, linewidth=0)
    ax.set_ylim(bottom=0)
    ax.grid(axis='y', alpha=.2, linewidth=.5)


def decorate(ax, phases, bands=False):
    for index, phase in enumerate(phases):
        if bands:
            ax.axvspan(phase['start_tV'], phase['end_tV'],
                       color=PHASE_COLORS[index % len(PHASE_COLORS)], alpha=.5, zorder=-5)
            name = phase['name']
            label = f'({name})' if name in 'abcd' else name
            ax.text((phase['start_tV'] + phase['end_tV']) / 2, 1.015, label,
                    transform=ax.get_xaxis_transform(), ha='center', fontsize=8)
    if phases and phases[0]['start_tV'] <= 600 <= phases[-1]['end_tV']:
        ax.axvline(600, color='#444444', linestyle=':', linewidth=.8)
    ax.set_xlabel(r'Dataset time $t_V$ (s)')


def stadium_figures(tables, manifest, output, plt, bands=False):
    native = read_rows(tables / 'native_timeseries.csv')
    counts = read_rows(tables / 'timeseries_10s.csv')
    crossings = read_rows(tables / 'crossings_10s.csv')
    totals = read_rows(tables / 'total_visible_roi_timeseries.csv') if (tables / 'total_visible_roi_timeseries.csv').exists() else []
    cameras = sorted({row['camera'] for row in native})
    paired = manifest['paired_seeds']
    for camera in cameras:
        fig, axes = plt.subplots(3, 1, figsize=(7.16, 6), sharex=True)
        fig.subplots_adjust(left=.12, right=.98, bottom=.10, top=.92, hspace=.24)
        people = [r for r in counts if r['camera'] == camera]
        events = [r for r in crossings if r['camera'] == camera]
        specifications = [(people, 'whole_roi_count_agents', 'People in ROI', 'dataset_time_tV'),
                          (people, 'mouth_front_count_agents', 'People in mouth-front area', 'dataset_time_tV'),
                          (events, 'cumulative_into_agents', 'Cumulative egress count', 'bin_end_tV')]
        for axis, (rows, field, label, time) in zip(axes, specifications):
            draw_series(axis, rows, field, time, paired.get(camera, []))
            decorate(axis, manifest['phases'][camera], bands)
            axis.set_ylabel(label)
        axes[0].legend(ncol=3, frameon=False, loc='upper left')
        fig.suptitle(f'Tunnel {camera}: {len(paired.get(camera, []))} paired seed(s)', fontsize=10)
        fig.text(.5, .015, 'Lines: seed means. Shading: seed minimum–maximum. Reference: automatic tracking.', ha='center', fontsize=8)
        save_figure(fig, output, f'tunnel_{camera}')
        plt.close(fig)
    row_count = math.ceil(len(cameras) / 2)
    fig, axes = plt.subplots(row_count, 2, figsize=(7.16, max(2.5, 1.5 * row_count)), squeeze=False, sharex=True)
    fig.subplots_adjust(left=.085, right=.98, bottom=.13, top=.90, hspace=.38, wspace=.25)
    for panel, (axis, camera) in enumerate(zip(axes.flat, cameras)):
        draw_series(axis, [r for r in native if r['camera'] == camera], 'whole_roi_count_agents', seeds=paired.get(camera, []))
        decorate(axis, manifest['phases'][camera], bands)
        axis.set_title(f'{camera} · {len(paired.get(camera, []))} paired seed(s)', loc='left')
        axis.set_ylabel('People in ROI')
        if panel // 2 < row_count - 1:
            axis.set_xlabel('')
            axis.tick_params(axis='x', labelbottom=False)
    for axis in list(axes.flat)[len(cameras):]:
        axis.set_visible(False)
    handles, labels = axes.flat[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc='upper center', ncol=3, frameon=False)
    save_figure(fig, output, 'occupancy_all_tunnels')
    plt.close(fig)
    if totals:
        common = sorted(set.intersection(*(set(paired[c]) for c in cameras if paired.get(c))))
        fig, axis = plt.subplots(figsize=(7.16, 2.7))
        fig.subplots_adjust(left=.10, right=.98, bottom=.20, top=.83)
        draw_series(axis, totals, 'sum_visible_roi_count_agents', seeds=common)
        decorate(axis, manifest['phases'][cameras[0]], bands)
        axis.set_ylabel('Sum of ROI counts (people)')
        axis.legend(ncol=3, frameon=False, loc='upper left')
        axis.set_title(f'{", ".join(cameras)} · {len(common)} common paired seed(s)', loc='left')
        save_figure(fig, output, 'total_occupancy')
        plt.close(fig)
    return native, totals


def overview_animation(native, totals, manifest, output, plt, seed, animate, fps, ffmpeg):
    """Render camera-local count tiles and the same saved seed on the timeline."""
    from matplotlib.animation import FFMpegWriter, PillowWriter
    from matplotlib.colors import Normalize
    from matplotlib.patches import Rectangle
    cameras = [camera for camera in 'ABCDEF' if seed in manifest['paired_seeds'].get(camera, [])]
    if not cameras:
        raise ValueError(f'No complete feedback pair for animation seed {seed}')
    total_cameras = totals[0]['included_cameras'].split(',') if totals else []
    if cameras != total_cameras:
        raise ValueError('Overview needs the selected seed in every tunnel included in the total series')
    index = {(camera, method): {} for camera in cameras for method in METHODS}
    for row in native:
        camera, method = row['camera'], row['method']
        if camera not in cameras or (method != 'observation_proxy' and row['seed'] != seed):
            continue
        time = int(round(row['dataset_time_tV']))
        if abs(row['dataset_time_tV'] - time) > 1e-5:
            raise ValueError('Overview requires native integer dataset-time samples')
        index[camera, method][time] = row['whole_roi_count_agents']
    end = int(max(row['dataset_time_tV'] for row in native))
    finite = [value for series in index.values() for value in series.values() if value is not None]
    maximum = max(10, math.ceil(max(finite, default=0) / 10) * 10)
    phases = manifest['phases'][cameras[0]]
    fig = plt.figure(figsize=(7.16, 4.0))
    grid = fig.add_gridspec(2, 2, height_ratios=[1, 1.7], hspace=.65, wspace=.15)
    fig.subplots_adjust(left=.10, right=.98, bottom=.17, top=.85)
    axes = [fig.add_subplot(grid[0, 0]), fig.add_subplot(grid[0, 1])]
    timeline = fig.add_subplot(grid[1, :])
    colors = plt.get_cmap('YlOrRd')
    normalize = Normalize(0, maximum)
    blocks, numbers = {}, {}
    for axis, method in zip(axes, ['observation_proxy', 'feedback_on']):
        axis.set(xlim=(0, 6), ylim=(0, 1.15))
        axis.axis('off')
        axis.set_title(LABELS[method] + (f', seed {seed}' if method == 'feedback_on' else ''), fontsize=9)
        for position, camera in enumerate('ABCDEF'):
            block = Rectangle((position + .02, .25), .90, .72, facecolor='#dddddd', edgecolor='#666666', linewidth=.6)
            axis.add_patch(block)
            blocks[camera, method] = block
            numbers[camera, method] = axis.text(position + .47, .61, '', ha='center', va='center', fontsize=9)
            axis.text(position + .47, .06, camera, ha='center', va='center', fontsize=8)
    draw_series(timeline, totals, 'sum_visible_roi_count_agents', seeds=[seed])
    decorate(timeline, phases, bands=True)
    timeline.set_ylabel('Sum of ROI counts\n(people)')
    timeline.legend(loc='upper left', frameon=False, fontsize=8)
    line = timeline.axvline(0, color='#b2182b', linewidth=1.0)
    title = fig.suptitle('', fontsize=11)
    fig.text(.5, .025, f'Included tunnels: {", ".join(cameras)}; gray = unavailable. Local ROI counts, seed {seed}.\nAnimation: 10 dataset seconds per frame at {fps} fps ({10 * fps}× dataset time).', ha='center', fontsize=8)
    color_axis = fig.add_axes([.80, .60, .16, .018])
    colorbar = fig.colorbar(plt.cm.ScalarMappable(norm=normalize, cmap=colors), cax=color_axis, orientation='horizontal')
    colorbar.set_label('People / ROI', fontsize=8)

    def draw(time):
        phase = next((p['name'] for p in phases if p['start_tV'] <= time < p['end_tV']), 'after')
        title.set_text(f'$t_V$ = {time} s · {PHASE_NAMES.get(phase, phase)}')
        line.set_xdata([time, time])
        for camera in 'ABCDEF':
            for method in ['observation_proxy', 'feedback_on']:
                count = index.get((camera, method), {}).get(time)
                blocks[camera, method].set_facecolor('#dddddd' if count is None else colors(normalize(count)))
                numbers[camera, method].set_text('—' if count is None else str(int(count)))

    for time in [300, 800, 1150, 1600, 2100, 2400]:
        if time <= end:
            draw(time)
            save_figure(fig, output, f'overview_t{time}')
    if animate:
        encoder = ffmpeg or shutil.which('ffmpeg')
        if encoder:
            import matplotlib
            matplotlib.rcParams['animation.ffmpeg_path'] = encoder
            writer, filename = FFMpegWriter(fps=fps, bitrate=1800), 'overview.mp4'
        else:
            writer, filename = PillowWriter(fps=fps), 'overview.gif'
        with writer.saving(fig, output / filename, dpi=110):
            for time in range(0, end + 1, 10):
                draw(time)
                writer.grab_frame()
    plt.close(fig)


def bottleneck_figures(tables, output, plt):
    rows = read_rows(tables / 'ensemble_summary.csv')
    paired_path = tables / 'paired_effects.csv'
    differences = read_rows(paired_path) if paired_path.exists() else []
    specifications = [('completion_time_model_s', 'Completion time', 'Model s'),
                      ('peak_gate_front_count_people', 'Peak gate-front count', 'People'),
                      ('peak_5s_exit_flux_people_per_model_s', 'Peak exit flux', 'People / model s')]
    fig, axes = plt.subplots(1, 3, figsize=(7.16, 2.7))
    fig.subplots_adjust(left=.07, right=.98, bottom=.23, top=.84, wspace=.40)
    for axis, (metric, title, unit) in zip(axes, specifications):
        for method in METHODS[1:]:
            values = sorted([r for r in rows if r['method'] == method and r['metric'] == metric], key=lambda r: r['arrival_rate_agents_per_model_s'])
            if values:
                error = [np.nan if r['sample_sd'] is None else r['sample_sd'] for r in values]
                axis.errorbar([r['arrival_rate_agents_per_model_s'] for r in values], [r['mean'] for r in values],
                              yerr=error, color=COLORS[method], linestyle=STYLES[method], marker='o',
                              markersize=3, capsize=2, linewidth=1, label=LABELS[method])
        axis.set_title(title)
        axis.set_ylabel(unit)
        axis.set_xticks(sorted({r['arrival_rate_agents_per_model_s'] for r in rows}))
        lower, upper = axis.get_ylim()
        span = upper - lower
        highest_star = upper
        for row in differences:
            lo, hi = row['ci95_lower'], row['ci95_upper']
            if row['metric'] == metric and lo is not None and (lo > 0 or hi < 0):
                rate = row['arrival_rate_agents_per_model_s']
                peaks = [r['mean'] + (r['sample_sd'] or 0) for r in rows
                         if r['metric'] == metric and r['arrival_rate_agents_per_model_s'] == rate]
                position = max(peaks) + .035 * span
                highest_star = max(highest_star, position + .08 * span)
                axis.text(rate, position, '*', ha='center', va='bottom')
        axis.set_ylim(lower, highest_star)
    axes[0].legend(frameon=False, loc='best')
    fig.text(.5, .07, 'Inflow (agents / model s)', ha='center', fontsize=8)
    fig.text(.5, .015, 'Bars: sample SD. * Paired ON − OFF 95% interval excludes zero. Run counts are in ensemble_summary.csv.', ha='center', fontsize=8)
    save_figure(fig, output, 'bottleneck_metrics')
    plt.close(fig)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evaluation', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True, help='New figure directory')
    parser.add_argument('--phase-bands', action='store_true', help='Show annotated phase bands in static time series')
    parser.add_argument('--animate', action='store_true', help='Also render the Stadium overview animation')
    parser.add_argument('--animation-seed', type=int, default=1)
    parser.add_argument('--fps', type=int, default=12)
    parser.add_argument('--ffmpeg', help='Existing FFmpeg executable; otherwise PATH is checked, then GIF is used')
    args = parser.parse_args(argv)
    output, evaluation = args.output.resolve(), args.evaluation.resolve()
    if output.exists():
        parser.error(f'Output already exists; choose a new directory: {output}')
    if args.fps <= 0:
        parser.error('--fps must be positive')
    manifest_path = evaluation / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    for filename, expected in manifest['output_sha256'].items():
        if digest(evaluation / filename) != expected:
            raise ValueError(f'Evaluation table differs from its manifest: {filename}')
    output.mkdir(parents=True, exist_ok=False)
    plt = setup_plot()
    tables = evaluation / 'figure_data'
    if manifest['experiment'] == 'bottleneck':
        if args.animate:
            parser.error('Bottleneck rendering exports static metrics; omit --animate')
        bottleneck_figures(tables, output, plt)
    else:
        native, totals = stadium_figures(tables, manifest, output, plt, args.phase_bands)
        if totals:
            available = [set(v) for v in manifest['paired_seeds'].values() if v]
            common = sorted(set.intersection(*available))
            seed = args.animation_seed
            if not args.animate and seed not in common:
                seed = common[0]
            overview_animation(native, totals, manifest, output, plt, seed,
                               args.animate, args.fps, args.ffmpeg)
    report = {'evaluation_manifest_sha256': digest(manifest_path), 'script_sha256': digest(__file__),
              'files': {p.name: digest(p) for p in sorted(output.iterdir()) if p.is_file()},
              'rendering': 'Saved evaluation tables; no interpolation, fitted curve, or new simulation.',
              'bands': 'Seed minimum–maximum, not a confidence interval.',
              'font': 'Times New Roman if installed, otherwise Liberation Serif or DejaVu Serif; PDF/PS Type 42.'}
    (output / 'manifest.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'output': str(output), 'files': list(report['files'])}, indent=2))


if __name__ == '__main__':
    main()
