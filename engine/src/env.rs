//! AHDSR envelope with adjustable curves.

use crate::util::curve_shape;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Stage {
    Idle,
    Attack,
    Hold,
    Decay,
    Sustain,
    Release,
}

#[derive(Clone, Copy, Debug)]
pub struct EnvParams {
    /// Times in seconds.
    pub attack: f32,
    pub hold: f32,
    pub decay: f32,
    /// Level 0..1.
    pub sustain: f32,
    pub release: f32,
    /// Curves -1..1, see `curve_shape`.
    pub atk_curve: f32,
    pub dec_curve: f32,
    pub rel_curve: f32,
}

#[derive(Clone, Copy, Debug)]
pub struct Env {
    pub stage: Stage,
    pub value: f32,
    /// Progress through the current stage, 0..1.
    t: f32,
    /// Level at the moment the current stage began.
    start: f32,
}

impl Default for Env {
    fn default() -> Self {
        Env { stage: Stage::Idle, value: 0.0, t: 0.0, start: 0.0 }
    }
}

const MIN_TIME: f32 = 1e-4;

impl Env {
    /// Start (or restart) from the current level, so retriggering a sounding
    /// voice does not click.
    pub fn gate_on(&mut self) {
        self.stage = Stage::Attack;
        self.t = 0.0;
        self.start = self.value;
    }

    pub fn gate_off(&mut self) {
        if self.stage != Stage::Idle && self.stage != Stage::Release {
            self.stage = Stage::Release;
            self.t = 0.0;
            self.start = self.value;
        }
    }

    pub fn kill(&mut self) {
        *self = Env::default();
    }

    pub fn is_idle(&self) -> bool {
        self.stage == Stage::Idle
    }

    /// Position for the UI playhead: stage number (1 attack .. 5 release)
    /// plus progress within it; 0 when idle.
    pub fn position(&self) -> f32 {
        match self.stage {
            Stage::Idle => 0.0,
            Stage::Attack => 1.0 + self.t.min(0.999),
            Stage::Hold => 2.0 + self.t.min(0.999),
            Stage::Decay => 3.0 + self.t.min(0.999),
            Stage::Sustain => 4.0,
            Stage::Release => 5.0 + self.t.min(0.999),
        }
    }

    /// Advance by `dt` seconds and return the level at the end.
    pub fn advance(&mut self, p: &EnvParams, dt: f32) -> f32 {
        let mut left = dt;
        // A stage shorter than the step hands its leftover time to the next.
        for _ in 0..6 {
            match self.stage {
                Stage::Idle => {
                    self.value = 0.0;
                    break;
                }
                Stage::Attack => {
                    if p.attack <= MIN_TIME {
                        self.value = 1.0;
                        self.next(Stage::Hold);
                        continue;
                    }
                    self.t += left / p.attack;
                    if self.t >= 1.0 {
                        left = (self.t - 1.0) * p.attack;
                        self.value = 1.0;
                        self.next(Stage::Hold);
                        continue;
                    }
                    self.value = self.start + (1.0 - self.start) * curve_shape(self.t, p.atk_curve);
                    break;
                }
                Stage::Hold => {
                    if p.hold <= MIN_TIME {
                        self.next(Stage::Decay);
                        continue;
                    }
                    self.t += left / p.hold;
                    if self.t >= 1.0 {
                        left = (self.t - 1.0) * p.hold;
                        self.next(Stage::Decay);
                        continue;
                    }
                    self.value = 1.0;
                    break;
                }
                Stage::Decay => {
                    if p.decay <= MIN_TIME {
                        self.value = p.sustain;
                        self.next(Stage::Sustain);
                        continue;
                    }
                    self.t += left / p.decay;
                    if self.t >= 1.0 {
                        self.value = p.sustain;
                        self.next(Stage::Sustain);
                        continue;
                    }
                    self.value = 1.0 + (p.sustain - 1.0) * curve_shape(self.t, p.dec_curve);
                    break;
                }
                Stage::Sustain => {
                    self.value = p.sustain;
                    break;
                }
                Stage::Release => {
                    if p.release <= MIN_TIME {
                        self.kill();
                        break;
                    }
                    self.t += left / p.release;
                    if self.t >= 1.0 {
                        self.kill();
                        break;
                    }
                    self.value = self.start * (1.0 - curve_shape(self.t, p.rel_curve));
                    break;
                }
            }
        }
        self.value
    }

    fn next(&mut self, stage: Stage) {
        self.stage = stage;
        self.t = 0.0;
        self.start = self.value;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> EnvParams {
        EnvParams { attack: 0.1, hold: 0.05, decay: 0.2, sustain: 0.5, release: 0.3, atk_curve: 0.0, dec_curve: 0.3, rel_curve: 0.3 }
    }

    #[test]
    fn walks_through_all_stages() {
        let p = params();
        let dt = 0.001;
        let mut e = Env::default();
        e.gate_on();
        let mut t = 0.0;
        let mut at = |e: &mut Env, until: f32| {
            let mut v = e.value;
            while t < until {
                v = e.advance(&p, dt);
                t += dt;
            }
            v
        };
        let v = at(&mut e, 0.05);
        assert!((v - 0.5).abs() < 0.03, "mid attack {v}");
        assert_eq!(e.stage, Stage::Attack);
        let v = at(&mut e, 0.12);
        assert!((v - 1.0).abs() < 1e-3, "hold {v}");
        assert_eq!(e.stage, Stage::Hold);
        at(&mut e, 0.2);
        assert_eq!(e.stage, Stage::Decay);
        let v = at(&mut e, 0.5);
        assert_eq!(e.stage, Stage::Sustain);
        assert!((v - 0.5).abs() < 1e-3);
        e.gate_off();
        let v = at(&mut e, 0.6);
        assert!(v < 0.5 && v > 0.0);
        at(&mut e, 0.9);
        assert!(e.is_idle());
        assert_eq!(e.value, 0.0);
    }

    #[test]
    fn zero_times_jump_immediately() {
        let p = EnvParams { attack: 0.0, hold: 0.0, decay: 0.0, sustain: 0.7, release: 0.0, atk_curve: 0.0, dec_curve: 0.0, rel_curve: 0.0 };
        let mut e = Env::default();
        e.gate_on();
        let v = e.advance(&p, 0.0007);
        assert!((v - 0.7).abs() < 1e-6);
        assert_eq!(e.stage, Stage::Sustain);
        e.gate_off();
        e.advance(&p, 0.0007);
        assert!(e.is_idle());
    }

    #[test]
    fn retrigger_starts_from_current_level() {
        let p = params();
        let mut e = Env::default();
        e.gate_on();
        for _ in 0..400 {
            e.advance(&p, 0.001);
        }
        let before = e.value;
        e.gate_on();
        let after = e.advance(&p, 0.001);
        assert!((after - before).abs() < 0.02, "jumped from {before} to {after}");
    }

    #[test]
    fn value_stays_in_range() {
        let p = params();
        let mut e = Env::default();
        e.gate_on();
        for i in 0..2000 {
            if i == 700 {
                e.gate_off();
            }
            let v = e.advance(&p, 0.0007);
            assert!((0.0..=1.0).contains(&v));
        }
    }
}
