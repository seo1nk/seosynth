//! Low-frequency oscillators: preset shapes, a drawable custom shape and two
//! chaotic ones that follow a strange attractor.

use crate::util::{curve_shape, smooth_coeff, Rng, TAU};

pub const LFO_TABLE: usize = 512;
pub const MAX_POINTS: usize = 32;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum LfoKind {
    Sine,
    Triangle,
    SawUp,
    SawDown,
    Square,
    SampleHold,
    Smooth,
    Custom,
    /// The Lorenz attractor: swings between two lobes at irregular times.
    Lorenz,
    /// The Rössler attractor: a steadier spiral that sometimes jumps.
    Rossler,
}

impl LfoKind {
    pub fn from_index(i: usize) -> LfoKind {
        use LfoKind::*;
        [Sine, Triangle, SawUp, SawDown, Square, SampleHold, Smooth, Custom, Lorenz, Rossler][i.min(9)]
    }

    pub fn is_chaos(self) -> bool {
        matches!(self, LfoKind::Lorenz | LfoKind::Rossler)
    }
}

/// A point moving on a strange attractor. One LFO cycle covers a few loops
/// of it, so the rate works as a speed.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Chaos {
    x: f32,
    y: f32,
    z: f32,
}

impl Chaos {
    /// Attractor time per LFO cycle, and the largest step that stays
    /// accurate with the midpoint method.
    fn scale(kind: LfoKind) -> (f32, f32) {
        match kind {
            LfoKind::Rossler => (18.0, 0.02),
            _ => (4.0, 0.004),
        }
    }

    fn deriv(kind: LfoKind, x: f32, y: f32, z: f32) -> (f32, f32, f32) {
        match kind {
            LfoKind::Rossler => (-y - z, x + 0.2 * y, 0.2 + z * (x - 5.7)),
            _ => (10.0 * (y - x), x * (28.0 - z) - y, x * y - 8.0 / 3.0 * z),
        }
    }

    /// The point `start` (0..1) of a cycle along a fixed path on the
    /// attractor, so the same start always gives the same movement.
    pub fn start(kind: LfoKind, start: f32) -> Chaos {
        let mut c = match kind {
            LfoKind::Rossler => Chaos { x: 1.0, y: -5.0, z: 0.02 },
            _ => Chaos { x: -8.0, y: 8.0, z: 27.0 },
        };
        c.advance(kind, start.max(0.0).min(1.0));
        c
    }

    /// Moves on by `cycles` LFO cycles.
    pub fn advance(&mut self, kind: LfoKind, cycles: f32) {
        let (per_cycle, max_h) = Chaos::scale(kind);
        let t = (cycles * per_cycle).max(0.0);
        let steps = (t / max_h).ceil().max(1.0).min(4096.0);
        let h = t / steps;
        for _ in 0..steps as usize {
            let (dx, dy, dz) = Chaos::deriv(kind, self.x, self.y, self.z);
            let (mx, my, mz) = (self.x + 0.5 * h * dx, self.y + 0.5 * h * dy, self.z + 0.5 * h * dz);
            let (dx, dy, dz) = Chaos::deriv(kind, mx, my, mz);
            self.x += h * dx;
            self.y += h * dy;
            self.z += h * dz;
        }
        // Never leave the attractor, whatever the input.
        if !(self.x.is_finite() && self.y.is_finite() && self.z.is_finite()) || self.x.abs() > 100.0 || self.z.abs() > 200.0 {
            *self = Chaos::start(kind, 0.0);
        }
    }

    /// Current value, 0..1.
    pub fn value(&self, kind: LfoKind) -> f32 {
        let v = match kind {
            LfoKind::Rossler => (self.x + 9.0) / 20.0,
            _ => 0.5 + self.x / 36.0,
        };
        v.max(0.0).min(1.0)
    }
}

impl Default for Chaos {
    fn default() -> Self {
        Chaos::start(LfoKind::Lorenz, 0.0)
    }
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum LfoMode {
    /// Restarts with every note.
    Trig,
    /// Runs through once per note, then holds its last value.
    Env,
    /// Free running, shared by all voices.
    Free,
}

impl LfoMode {
    pub fn from_index(i: usize) -> LfoMode {
        [LfoMode::Trig, LfoMode::Env, LfoMode::Free][i.min(2)]
    }
}

/// One breakpoint of a custom shape. `curve` bends the segment that starts at
/// this point (-1..1, see `curve_shape`).
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct LfoPoint {
    pub x: f32,
    pub y: f32,
    pub curve: f32,
}

/// The default custom shape: a triangle.
pub fn default_points() -> Vec<LfoPoint> {
    vec![
        LfoPoint { x: 0.0, y: 0.0, curve: 0.0 },
        LfoPoint { x: 0.5, y: 1.0, curve: 0.0 },
        LfoPoint { x: 1.0, y: 0.0, curve: 0.0 },
    ]
}

/// Cleans up points coming from outside: clamps, sorts, limits the count.
pub fn sanitize_points(points: &mut Vec<LfoPoint>) {
    points.retain(|p| p.x.is_finite() && p.y.is_finite() && p.curve.is_finite());
    for p in points.iter_mut() {
        p.x = p.x.max(0.0).min(1.0);
        p.y = p.y.max(0.0).min(1.0);
        p.curve = p.curve.max(-1.0).min(1.0);
    }
    points.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
    points.truncate(MAX_POINTS);
    if points.is_empty() {
        *points = default_points();
    }
}

/// Renders a custom shape into a lookup table of `LFO_TABLE + 1` values.
pub fn render_points(points: &[LfoPoint], table: &mut [f32]) {
    let n = table.len() - 1;
    if points.is_empty() {
        table.iter_mut().for_each(|v| *v = 0.0);
        return;
    }
    let mut seg = 0;
    for (i, out) in table.iter_mut().enumerate() {
        let x = i as f32 / n as f32;
        while seg + 1 < points.len() && points[seg + 1].x <= x {
            seg += 1;
        }
        let a = points[seg];
        *out = if x < a.x || seg + 1 >= points.len() {
            a.y
        } else {
            let b = points[seg + 1];
            let span = b.x - a.x;
            if span <= 1e-6 {
                b.y
            } else {
                a.y + (b.y - a.y) * curve_shape((x - a.x) / span, a.curve)
            }
        };
    }
}

/// Value (0..1) of a shape at `phase` (0..1). `ra`/`rb` are the current and
/// next random values for the random shapes. The chaotic shapes have no
/// value by phase (see `Chaos`); they give the middle here.
#[inline]
pub fn eval(kind: LfoKind, phase: f32, table: &[f32], ra: f32, rb: f32) -> f32 {
    match kind {
        LfoKind::Sine => 0.5 + 0.5 * (TAU * phase).sin(),
        LfoKind::Triangle => 1.0 - (2.0 * phase - 1.0).abs(),
        LfoKind::SawUp => phase,
        LfoKind::SawDown => 1.0 - phase,
        LfoKind::Square => {
            if phase < 0.5 {
                1.0
            } else {
                0.0
            }
        }
        LfoKind::SampleHold => ra,
        LfoKind::Smooth => {
            let t = phase * phase * (3.0 - 2.0 * phase);
            ra + (rb - ra) * t
        }
        LfoKind::Custom => {
            let x = phase.max(0.0).min(1.0) * LFO_TABLE as f32;
            let i = (x as usize).min(LFO_TABLE - 1);
            table[i] + (table[i + 1] - table[i]) * (x - i as f32)
        }
        LfoKind::Lorenz | LfoKind::Rossler => 0.5,
    }
}

#[derive(Clone, Copy, Debug)]
pub struct LfoParams {
    pub kind: LfoKind,
    pub rate_hz: f32,
    pub mode: LfoMode,
    pub rise: f32,
    pub delay: f32,
    pub smooth: f32,
    pub phase: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct LfoState {
    pub phase: f32,
    time: f32,
    ra: f32,
    rb: f32,
    out: f32,
    done: bool,
    fresh: bool,
    chaos: Chaos,
    /// Which attractor `chaos` was started on.
    chaos_kind: Option<LfoKind>,
    start: f32,
}

impl Default for LfoState {
    fn default() -> Self {
        LfoState { phase: 0.0, time: 0.0, ra: 0.5, rb: 0.5, out: 0.0, done: false, fresh: true, chaos: Chaos::default(), chaos_kind: None, start: 0.0 }
    }
}

impl LfoState {
    pub fn trigger(&mut self, start_phase: f32, rng: &mut Rng) {
        self.phase = start_phase - start_phase.floor();
        self.time = 0.0;
        self.ra = rng.unipolar();
        self.rb = rng.unipolar();
        self.done = false;
        self.fresh = true;
        self.start = start_phase;
        // Started on the attractor when first used.
        self.chaos_kind = None;
    }

    /// Advance by `dt` seconds. `free_phase` is the shared phase used in Free
    /// mode and `free_chaos` the shared value of a chaotic shape. Returns
    /// (value 0..1, fade 0..1); the fade is the rise/delay envelope, kept
    /// separate so a bipolar routing can fade around its centre rather than
    /// from the bottom.
    pub fn advance(&mut self, p: &LfoParams, dt: f32, free_phase: f32, free_chaos: f32, table: &[f32], rng: &mut Rng) -> (f32, f32) {
        let mut fade = 1.0;
        let before = self.phase;
        match p.mode {
            LfoMode::Free => {
                let ph = free_phase + p.phase;
                let ph = ph - ph.floor();
                if ph < self.phase {
                    self.roll(rng);
                }
                self.phase = ph;
            }
            LfoMode::Trig | LfoMode::Env => {
                self.time += dt;
                let running = self.time - p.delay;
                if running <= 0.0 {
                    fade = 0.0;
                } else {
                    if p.rise > 1e-4 {
                        fade = (running / p.rise).min(1.0);
                    }
                    if !self.done {
                        self.phase += p.rate_hz * dt;
                        if self.phase >= 1.0 {
                            if p.mode == LfoMode::Env {
                                self.phase = 1.0;
                                self.done = true;
                            } else {
                                self.phase -= self.phase.floor();
                                self.roll(rng);
                            }
                        }
                    }
                }
            }
        }
        let target = if !p.kind.is_chaos() {
            eval(p.kind, self.phase, table, self.ra, self.rb)
        } else if p.mode == LfoMode::Free {
            free_chaos
        } else {
            if self.chaos_kind != Some(p.kind) {
                self.chaos = Chaos::start(p.kind, self.start - self.start.floor());
                self.chaos_kind = Some(p.kind);
            }
            // As far as the phase moved (it wraps, and holds once done).
            let mut moved = self.phase - before;
            if moved < 0.0 {
                moved += 1.0;
            }
            self.chaos.advance(p.kind, moved);
            self.chaos.value(p.kind)
        };
        if self.fresh || p.smooth <= 1e-4 {
            self.out = target;
            self.fresh = false;
        } else {
            let c = smooth_coeff(p.smooth * p.smooth * 0.5, 1.0, dt);
            self.out += (target - self.out) * c;
        }
        (self.out, fade)
    }

    fn roll(&mut self, rng: &mut Rng) {
        self.ra = self.rb;
        self.rb = rng.unipolar();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params(kind: LfoKind, mode: LfoMode) -> LfoParams {
        LfoParams { kind, rate_hz: 2.0, mode, rise: 0.0, delay: 0.0, smooth: 0.0, phase: 0.0 }
    }

    #[test]
    fn shapes_stay_in_range() {
        let mut table = [0.0f32; LFO_TABLE + 1];
        render_points(&default_points(), &mut table);
        for k in 0..8 {
            let kind = LfoKind::from_index(k);
            for i in 0..=100 {
                let v = eval(kind, i as f32 / 100.0, &table, 0.2, 0.9);
                assert!((0.0..=1.0).contains(&v), "{kind:?} {v}");
            }
        }
    }

    #[test]
    fn custom_shape_follows_points() {
        let pts = vec![
            LfoPoint { x: 0.0, y: 0.2, curve: 0.0 },
            LfoPoint { x: 0.25, y: 1.0, curve: 0.0 },
            LfoPoint { x: 1.0, y: 0.0, curve: 0.0 },
        ];
        let mut table = [0.0f32; LFO_TABLE + 1];
        render_points(&pts, &mut table);
        let at = |x: f32| eval(LfoKind::Custom, x, &table, 0.0, 0.0);
        assert!((at(0.0) - 0.2).abs() < 1e-3);
        assert!((at(0.125) - 0.6).abs() < 1e-2);
        assert!((at(0.25) - 1.0).abs() < 1e-2);
        assert!((at(0.625) - 0.5).abs() < 1e-2);
        assert!(at(1.0).abs() < 1e-3);
    }

    #[test]
    fn trig_mode_cycles_at_the_requested_rate() {
        let table = [0.0f32; LFO_TABLE + 1];
        let p = params(LfoKind::SawUp, LfoMode::Trig);
        let mut st = LfoState::default();
        let mut rng = Rng::new(1);
        st.trigger(0.0, &mut rng);
        let dt = 0.001;
        let mut wraps = 0;
        let mut last = 0.0;
        for _ in 0..3000 {
            let (v, _) = st.advance(&p, dt, 0.0, 0.5, &table, &mut rng);
            if v < last - 0.5 {
                wraps += 1;
            }
            last = v;
        }
        assert_eq!(wraps, 5, "3 s at 2 Hz wraps 5 times before the 6th completes");
    }

    #[test]
    fn env_mode_runs_once_and_holds() {
        let table = [0.0f32; LFO_TABLE + 1];
        let p = params(LfoKind::SawUp, LfoMode::Env);
        let mut st = LfoState::default();
        let mut rng = Rng::new(1);
        st.trigger(0.0, &mut rng);
        let mut v = 0.0;
        for _ in 0..2000 {
            v = st.advance(&p, 0.001, 0.0, 0.5, &table, &mut rng).0;
        }
        assert!((v - 1.0).abs() < 1e-6);
    }

    #[test]
    fn delay_and_rise_shape_the_fade() {
        let table = [0.0f32; LFO_TABLE + 1];
        let mut p = params(LfoKind::Sine, LfoMode::Trig);
        p.delay = 0.1;
        p.rise = 0.2;
        let mut st = LfoState::default();
        let mut rng = Rng::new(1);
        st.trigger(0.0, &mut rng);
        let mut fades = Vec::new();
        for _ in 0..400 {
            fades.push(st.advance(&p, 0.001, 0.0, 0.5, &table, &mut rng).1);
        }
        assert_eq!(fades[50], 0.0);
        assert!((fades[199] - 0.5).abs() < 0.02);
        assert_eq!(fades[399], 1.0);
    }

    #[test]
    fn chaos_wanders_but_stays_in_range() {
        let table = [0.0f32; LFO_TABLE + 1];
        for kind in [LfoKind::Lorenz, LfoKind::Rossler] {
            let p = LfoParams { rate_hz: 1.5, ..params(kind, LfoMode::Trig) };
            let mut rng = Rng::new(7);
            let run = |start: f32, rng: &mut Rng| {
                let mut st = LfoState::default();
                st.trigger(start, rng);
                (0..4000).map(|_| st.advance(&p, 0.001, 0.0, 0.5, &table, rng).0).collect::<Vec<f32>>()
            };
            let a = run(0.0, &mut rng);
            assert!(a.iter().all(|v| (0.0..=1.0).contains(v)), "{kind:?}");
            let (lo, hi) = a.iter().fold((1.0f32, 0.0f32), |(l, h), &v| (l.min(v), h.max(v)));
            assert!(hi - lo > 0.5, "{kind:?} moves widely: {lo}..{hi}");
            // Not periodic: the second second differs from the first.
            let diff = (0..1000).map(|i| (a[i] - a[i + 1000]).abs()).fold(0.0f32, f32::max);
            assert!(diff > 0.2, "{kind:?}");
            // The same start gives the same movement; another start does not.
            assert_eq!(a, run(0.0, &mut rng));
            assert_ne!(a, run(0.5, &mut rng));
        }
    }

    #[test]
    fn chaos_matches_its_preview_and_survives_huge_steps() {
        let mut c = Chaos::start(LfoKind::Lorenz, 0.25);
        let mut d = Chaos::start(LfoKind::Lorenz, 0.0);
        d.advance(LfoKind::Lorenz, 0.25);
        assert!((c.value(LfoKind::Lorenz) - d.value(LfoKind::Lorenz)).abs() < 1e-3);
        c.advance(LfoKind::Lorenz, 1e9);
        assert!((0.0..=1.0).contains(&c.value(LfoKind::Lorenz)));
    }

    #[test]
    fn sanitize_fixes_bad_input() {
        let mut pts = vec![
            LfoPoint { x: 2.0, y: -1.0, curve: 5.0 },
            LfoPoint { x: f32::NAN, y: 0.5, curve: 0.0 },
            LfoPoint { x: 0.3, y: 0.5, curve: 0.0 },
        ];
        sanitize_points(&mut pts);
        assert_eq!(pts.len(), 2);
        assert_eq!(pts[0].x, 0.3);
        assert_eq!(pts[1], LfoPoint { x: 1.0, y: 0.0, curve: 1.0 });
    }
}
