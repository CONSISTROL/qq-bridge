import sys, json, numpy as np
import soundfile as sf
import librosa

def load(p, sr=16000):
    d, s = sf.read(p)
    if d.ndim > 1: d = d.mean(axis=1)
    if s != sr: d = librosa.resample(d.astype(np.float32), orig_sr=s, target_sr=sr)
    return np.asarray(d, dtype=np.float32), sr

def f0_series(y, sr):
    # pyin 更稳，取 voiced 概率高的帧
    f0, vflag, vprob = librosa.pyin(y, fmin=60, fmax=1100, sr=sr, frame_length=2048)
    return f0, vflag

def cents_diff(a, b):
    m = np.isfinite(a) & np.isfinite(b) & (a > 0) & (b > 0)
    if m.sum() < 20: return None, None, int(m.sum())
    c = 1200 * np.log2(a[m] / b[m])
    # 八度折叠（避免整八度被算成跑调）
    c = (c + 600) % 1200 - 600
    return float(np.median(np.abs(c))), float((np.abs(c) > 100).mean()), int(m.sum())

def flatness(y, sr):
    spec = np.abs(librosa.stft(y, n_fft=1024)) + 1e-9
    return float(np.mean(librosa.feature.spectral_flatness(S=spec)))

def breathiness(y, sr):
    # 2–6 kHz 的平坦度：气声/沙哑会把这个抬高
    spec = np.abs(librosa.stft(y, n_fft=1024)) + 1e-9
    freqs = librosa.fft_frequencies(sr=sr, n_fft=1024)
    band = spec[(freqs >= 2000) & (freqs <= 6000)]
    if not band.size: return None
    return float(np.mean(librosa.feature.spectral_flatness(S=band)))

def hnr(y):
    # 简化 HNR：自相关峰值 / (1-峰值)
    if len(y) < 1024: return None
    ac = librosa.autocorrelate(y, max_size=len(y))
    ac = ac / (ac[0] + 1e-9)
    seg = ac[50:400]
    if not len(seg): return None
    r = float(np.max(seg))
    r = min(max(r, 1e-3), 0.999)
    return float(10 * np.log10(r / (1 - r)))

def main():
    cand, ref = sys.argv[1], sys.argv[2]
    # 期望移调（半音）：AI 唱的是"参考人声升高 N 个半音"后的版本，比较时要把参考也移回去
    shift = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
    yc, sr = load(cand); yr, _ = load(ref)
    n = min(len(yc), len(yr)); yc, yr = yc[:n], yr[:n]
    f0c, _ = f0_series(yc, sr); f0r, _ = f0_series(yr, sr)
    if shift:
        f0r = f0r * (2 ** (shift / 12.0))
    med, off, frames = cents_diff(f0c, f0r)
    spec = np.abs(librosa.stft(yc, n_fft=1024)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=1024)
    hi = spec[freqs > 3000].sum(); tot = spec.sum() + 1e-9
    both = np.isfinite(f0c) & (f0c > 0)
    jitter = None
    if both.sum() > 10:
        f = 1200 * np.log2(f0c[both][1:] / f0c[both][:-1])
        jitter = float(np.median(np.abs(f)))
    out = {
        "seconds": round(n / sr, 2),
        "voicedFrames": frames,
        "centsMedianAbs": med,
        "offRatio": off,
        "flatness": flatness(yc, sr),
        "breathiness": breathiness(yc, sr),
        "hnrDb": hnr(yc),
        "highFreqRatio": float(hi / tot),
        "f0JitterCents": jitter,
        "rms": float(np.sqrt((yc.astype(np.float64) ** 2).mean())),
        "peak": float(np.abs(yc).max())
    }
    print(json.dumps(out))
main()
