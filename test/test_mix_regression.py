#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""混音链回归测试 —— 专治「跑得通但结果错」。

这两个 bug 都是静默的：程序不报错，只是人声没了 / 声场没了。
所以必须有断言。用法：
  python test/test_mix_regression.py        # 全部通过退出码 0，否则 1
也兼容 pytest：pytest test/test_mix_regression.py
"""
import os
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
# 核心模块在 diffsinger-hutao/（唱歌链路 Python 代码统一放这里）
sys.path.insert(0, str(HERE.parent / 'diffsinger-hutao'))

import mix_master as mm            # noqa: E402
import metrics as M                # noqa: E402

SR = 44100
FAILS = []


def check(name, cond, detail=''):
    if cond:
        print(f'  ✅ {name}' + (f'  · {detail}' if detail else ''))
    else:
        print(f'  ❌ {name}' + (f'  · {detail}' if detail else ''))
        FAILS.append(name)


# ── 1. _delay：干声不能丢，首尾不能环绕 ──────────────────────────
def test_delay_dry_and_no_wrap():
    n = SR * 2
    x = np.zeros((n, 2))
    # 1.0s 处一个短促脉冲（模拟一个字头），其余静音
    x[int(1.0 * SR):int(1.0 * SR) + 200, :] = 0.5
    y = mm._delay(x, SR, delay_ms=130.0, feedback=0.25, mix=0.10)

    # 干声必须保留：脉冲位置幅度不能掉
    dry_peak = float(np.max(np.abs(y[int(1.0 * SR):int(1.0 * SR) + 200, 0])))
    check('_delay 保留干声（脉冲幅度 ≥0.5）', dry_peak >= 0.49, f'实测 {dry_peak:.3f}')

    # 首端不能有湿声（延迟 130ms，前 130ms 内应为纯静音）
    head = float(np.max(np.abs(y[:int(0.12 * SR)])))
    check('_delay 首端无湿声（无环绕）', head < 1e-6, f'首 120ms 峰值 {head:.2e}')

    # 尾端不能出现开头的回绕（np.roll 的典型症状）
    tail = float(np.max(np.abs(y[-int(0.01 * SR):])))
    check('_delay 尾端无回绕', tail < 1e-6, f'末 10ms 峰值 {tail:.2e}')

    # 延迟位置确实有湿声
    wet = float(np.max(np.abs(y[int(1.13 * SR):int(1.14 * SR)])))
    check('_delay 在 130ms 处有湿声', wet > 1e-4, f'实测 {wet:.4f}')


# ── 2. M/S 展宽：mid 不变、side 按倍数放大、不能为 0 ─────────────
def test_widen_ms():
    n = 1000
    t = np.arange(n) / SR
    mid = np.sin(2 * np.pi * 220 * t) * 0.5
    side = np.sin(2 * np.pi * 330 * t) * 0.1
    x = np.stack([mid + side, mid - side], axis=1)

    for w in (1.0, 2.0, 3.6):
        y = mm._widen(x, w)
        m1 = M.side_stats(x)
        m2 = M.side_stats(y)
        ok_mid = abs(m2['mid_rms_dbfs'] - m1['mid_rms_dbfs']) < 0.05
        expect = m1['side_rms_dbfs'] + 20 * np.log10(w)
        ok_side = abs(m2['side_rms_dbfs'] - expect) < 0.3
        check(f'_widen({w}) mid 不变', ok_mid,
              f"{m1['mid_rms_dbfs']} → {m2['mid_rms_dbfs']} dBFS")
        check(f'_widen({w}) side 按 {w:g}× 放大', ok_side,
              f"{m1['side_rms_dbfs']} → {m2['side_rms_dbfs']}（期望 {expect:.1f}）")

    # 极端：全单声道输入，展宽后 side 仍为 0（不应凭空造出侧向）
    mono = np.stack([mid, mid], axis=1)
    y = mm._widen(mono, 4.0)
    zero_side = M.side_stats(y)['side_rms_dbfs'] < -100
    check('_widen 对纯单声道不凭空造 side', zero_side)


# ── 3. Side 电平断言（成品级别的门禁） ───────────────────────────
def test_side_level_assertion():
    """合成一个「人声居中 + pad 偏左 + hat 偏右」的混音，断言 Side 落在目标带内。"""
    n = SR * 3
    t = np.arange(n) / SR
    vocal = np.sin(2 * np.pi * 440 * t) * 0.25
    pad = np.sin(2 * np.pi * 220 * t) * 0.18
    hat = (np.random.default_rng(0).standard_normal(n) * 0.05)
    left = vocal + pad + hat * 0.05
    right = vocal + hat + pad * 0.05
    mix = mm._widen(np.stack([left, right], axis=1), 2.1)
    st = M.side_stats(mix)
    check('Side 电平在 -35 ~ -12 dBFS 之间（可听但不失真）',
          -35 <= st['side_rms_dbfs'] <= -12, f"{st['side_rms_dbfs']} dBFS")
    check('Side 相对 Mid 不低于 -30dB（不是假立体声）',
          st['side_rel_mid_db'] > -30, f"{st['side_rel_mid_db']} dB")
    check('单声道折叠不削波（峰值 <0.98）', st['mono_fold_peak'] < 0.98,
          f"{st['mono_fold_peak']}")


# ── 4. vocal_corr 门禁：人声在/不在必须分得开 ────────────────────
def test_vocal_corr_gate():
    n = SR * 4
    t = np.arange(n) / SR
    rng = np.random.default_rng(1)
    vocal = (np.sin(2 * np.pi * 300 * t + 3 * np.sin(2 * np.pi * 5 * t)) * 0.45
             + rng.standard_normal(n) * 0.01)
    inst = np.sin(2 * np.pi * 110 * t) * 0.20

    # A：人声正常混入（且故意整体延迟 37 个采样，验证"对齐"这一步真的在工作）
    lag = 37
    vocal_shift = np.concatenate([np.zeros(lag), vocal[:n - lag]])
    with_vocal = inst + vocal_shift
    r1 = M.aligned_corr(vocal, with_vocal, sr=SR)
    check('人声存在时对齐相关 >0.8', r1['corr'] > 0.8, f"corr={r1['corr']}")
    check('能找回 37 采样延迟', abs(r1['lag_samples'] - lag) <= 2,
          f"lag={r1['lag_samples']} 采样 / {r1['lag_ms']}ms")
    check('未对齐相关明显更低（说明对齐有必要）',
          r1['corr_at_zero'] < r1['corr'] - 0.05,
          f"zero={r1['corr_at_zero']} vs aligned={r1['corr']}")

    # B：没有人声
    r2 = M.aligned_corr(vocal, inst, sr=SR)
    check('人声缺失时相关 <0.2（门禁能拦住）', r2['corr'] < 0.2, f"corr={r2['corr']}")


# ── 5. 带通/动态口径自洽 ─────────────────────────────────────────
def test_band_and_dr():
    n = SR * 4
    t = np.arange(n) / SR
    low = np.sin(2 * np.pi * 60 * t) * 0.5
    ratio = M.band_ratio_db(low, SR, 40, 80)
    check('60Hz 正弦的 40-80Hz 占比接近 0dB', ratio > -3.0, f'{ratio} dB')
    dr = M.dynamic_range_db(np.concatenate([low * 0.1, low]) * 1.0, SR)
    check('段落差 20dB 的材料 DR 明显大于 8', dr > 8.0, f'{dr} dB')


# ── 6. 采样率/长度断言（load_pair 门禁） ─────────────────────────
def test_load_pair_guard():
    import tempfile
    import soundfile as sf
    rng = np.random.default_rng(3)
    with tempfile.TemporaryDirectory() as td:
        mixp = os.path.join(td, 'mix.wav')
        dryp = os.path.join(td, 'dry.wav')
        # 48k 干声 vs 44.1k 成品：load_pair 应自动重采样且不报错
        sf.write(mixp, rng.standard_normal(44100 * 3).astype('float32'), 44100)
        sf.write(dryp, rng.standard_normal(48000 * 3).astype('float32'), 48000)
        m, d, sr = M.load_pair(mixp, dryp)
        check('load_pair 自动把 48k 重采样到 44.1k', sr == 44100 and len(m) == len(d),
              f'sr={sr} len {len(m)}/{len(d)}')
        # 长度差 >5%：应抛错（提示采样率/片段不一致），而不是静默算出假相关
        sf.write(dryp, rng.standard_normal(44100 * 10).astype('float32'), 44100)
        raised = False
        try:
            M.load_pair(mixp, dryp)
        except ValueError:
            raised = True
        check('load_pair 对长度差 >5% 抛错（防假相关）', raised)


def test_sentence_duck():
    """句级避让：气口处伴奏降 duck_db，活跃处不变，且不产生削波。"""
    sr = 44100
    n = sr * 4
    rng = np.random.default_rng(7)
    # 人声干声：0.5-1.5s 活跃（响），其余气口（静）
    vocal = np.zeros(n)
    t = np.arange(n) / sr
    active = (t >= 0.5) & (t < 1.5)
    vocal[active] = np.sin(2 * np.pi * 300 * t[active]) * 0.5
    vocal *= np.hanning(n)  # 平滑
    inst = rng.standard_normal(n) * 0.3  # 伴奏恒定电平
    out = mm._sentence_duck(inst, vocal, sr, duck_db=-6.0, thresh_db=-30.0)
    win = int(sr * 0.05)
    gap_i = int(0.2 * sr) // win      # 气口段
    act_i = int(1.0 * sr) // win      # 活跃段
    g_gap = np.sqrt(np.mean(out[gap_i * win:(gap_i + 1) * win] ** 2))
    g_act = np.sqrt(np.mean(out[act_i * win:(act_i + 1) * win] ** 2))
    i_gap = np.sqrt(np.mean(inst[gap_i * win:(gap_i + 1) * win] ** 2))
    check('句级避让：气口处伴奏降约 6dB', abs(20 * np.log10(g_gap / i_gap) - (-6.0)) < 1.5,
          f'{20*np.log10(g_gap/i_gap):.1f} dB')
    i_act = np.sqrt(np.mean(inst[act_i * win:(act_i + 1) * win] ** 2))
    check('句级避让：活跃处伴奏不变', abs(20 * np.log10(g_act / i_act)) < 1.0,
          f'{20*np.log10(g_act/i_act):.1f} dB')
    check('句级避让：只降不升（不引入削波）',
          float(np.max(np.abs(out))) <= float(np.max(np.abs(inst))) * 1.01)


def main():
    print('=== 混音链回归测试 ===')
    test_delay_dry_and_no_wrap()
    test_widen_ms()
    test_side_level_assertion()
    test_vocal_corr_gate()
    test_band_and_dr()
    test_load_pair_guard()
    test_sentence_duck()
    print()
    if FAILS:
        print(f'❌ 失败 {len(FAILS)} 项：' + '、'.join(FAILS))
        return 1
    print('✅ 全部通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
