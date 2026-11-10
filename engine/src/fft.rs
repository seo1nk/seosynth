//! Minimal in-place radix-2 complex FFT. Used to band-limit wavetables and
//! to compute filter response curves for the UI; not used on the audio path.

use crate::util::TAU;

pub struct Fft {
    n: usize,
    cos: Vec<f32>,
    sin: Vec<f32>,
    rev: Vec<u32>,
}

impl Fft {
    pub fn new(n: usize) -> Self {
        assert!(n.is_power_of_two() && n >= 2);
        let bits = n.trailing_zeros();
        let mut cos = Vec::with_capacity(n / 2);
        let mut sin = Vec::with_capacity(n / 2);
        for i in 0..n / 2 {
            let a = TAU * i as f32 / n as f32;
            cos.push(a.cos());
            sin.push(a.sin());
        }
        let rev = (0..n as u32).map(|i| i.reverse_bits() >> (32 - bits)).collect();
        Fft { n, cos, sin, rev }
    }

    pub fn len(&self) -> usize {
        self.n
    }

    /// Forward transform: X[k] = sum x[n] e^{-2 pi i k n / N} (unnormalised).
    pub fn forward(&self, re: &mut [f32], im: &mut [f32]) {
        self.transform(re, im, false);
    }

    /// Inverse transform, normalised by 1/N.
    pub fn inverse(&self, re: &mut [f32], im: &mut [f32]) {
        self.transform(re, im, true);
        let s = 1.0 / self.n as f32;
        for v in re.iter_mut() {
            *v *= s;
        }
        for v in im.iter_mut() {
            *v *= s;
        }
    }

    fn transform(&self, re: &mut [f32], im: &mut [f32], inverse: bool) {
        let n = self.n;
        assert!(re.len() == n && im.len() == n);
        for i in 0..n {
            let j = self.rev[i] as usize;
            if j > i {
                re.swap(i, j);
                im.swap(i, j);
            }
        }
        let mut size = 2;
        while size <= n {
            let half = size / 2;
            let step = n / size;
            let mut start = 0;
            while start < n {
                for k in 0..half {
                    let wr = self.cos[k * step];
                    let wi = if inverse { self.sin[k * step] } else { -self.sin[k * step] };
                    let a = start + k;
                    let b = a + half;
                    let tr = re[b] * wr - im[b] * wi;
                    let ti = re[b] * wi + im[b] * wr;
                    re[b] = re[a] - tr;
                    im[b] = im[a] - ti;
                    re[a] += tr;
                    im[a] += ti;
                }
                start += size;
            }
            size *= 2;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_sine_lands_in_one_bin() {
        let n = 64;
        let fft = Fft::new(n);
        let mut re: Vec<f32> = (0..n).map(|i| (TAU * 5.0 * i as f32 / n as f32).sin()).collect();
        let mut im = vec![0.0; n];
        fft.forward(&mut re, &mut im);
        for k in 0..n {
            let mag = (re[k] * re[k] + im[k] * im[k]).sqrt();
            if k == 5 || k == n - 5 {
                assert!((mag - n as f32 / 2.0).abs() < 1e-2, "bin {k} mag {mag}");
            } else {
                assert!(mag < 1e-2, "bin {k} mag {mag}");
            }
        }
    }

    #[test]
    fn roundtrip() {
        let n = 256;
        let fft = Fft::new(n);
        let orig: Vec<f32> = (0..n).map(|i| ((i * 37 % 101) as f32 / 50.0) - 1.0).collect();
        let mut re = orig.clone();
        let mut im = vec![0.0; n];
        fft.forward(&mut re, &mut im);
        fft.inverse(&mut re, &mut im);
        for i in 0..n {
            assert!((re[i] - orig[i]).abs() < 1e-4);
            assert!(im[i].abs() < 1e-4);
        }
    }
}
