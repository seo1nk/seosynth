//! Building wavetables on the audio thread without stopping the sound.
//!
//! Band-limiting a frame (one FFT and eleven inverse FFTs) takes a few
//! tenths of a millisecond, and a table can have dozens of frames: done in
//! one go, choosing a new table would take longer than one audio callback
//! and the sound would drop out. On the audio thread tables are therefore
//! built a couple of frames per callback, and the oscillator keeps playing
//! the table it had until the new one is complete.
//!
//! Factory tables are generated (not band-limited) on the main thread and
//! handed over as raw frames: generating some of them takes milliseconds
//! too, and it cannot be split into frames. User tables come with the patch.

use crate::wavetable::{Bank, FrameBuilder, UserTable, Wavetable, FACTORY_TABLES, TABLE_SIZE};
use std::rc::Rc;

/// Frames built per audio callback.
pub const FRAMES_PER_CALL: usize = 2;

enum Source {
    /// Generated frames of a factory table, `TABLE_SIZE` samples each.
    Raw(Vec<f32>),
    User(UserTable),
}

struct Job {
    /// Index in the bank.
    index: usize,
    table: Wavetable,
    source: Source,
    /// Frames still to build.
    todo: Vec<usize>,
}

#[derive(Default)]
pub struct TableJobs {
    jobs: Vec<Job>,
    work: Option<FrameBuilder>,
    cycle: Vec<f32>,
    /// Raw frames handed over for a factory table, before `start_raw`.
    offered: Option<(usize, Vec<f32>)>,
}

impl TableJobs {
    pub fn is_pending(&self, index: usize) -> bool {
        self.jobs.iter().any(|j| j.index == index)
    }

    /// Room for the raw frames of factory table `index`, to be filled by the
    /// caller and then handed over with `start_offered`.
    pub fn offer(&mut self, index: usize, frames: usize) -> &mut [f32] {
        let (_, data) = self.offered.insert((index, vec![0.0; frames.clamp(1, 1024) * TABLE_SIZE]));
        data
    }

    /// Starts building the offered factory table, unless it is built already.
    pub fn start_offered(&mut self, bank: &Bank) {
        let Some((index, raw)) = self.offered.take() else { return };
        if index >= FACTORY_TABLES || bank.peek(index).is_some() || self.is_pending(index) {
            return;
        }
        let frames = raw.len() / TABLE_SIZE;
        self.jobs.push(Job { index, table: Wavetable::empty(frames), source: Source::Raw(raw), todo: (0..frames).rev().collect() });
    }

    /// Brings user table `slot` up to date with `table`. Only the frames
    /// that differ from what is built (or being built) are redone.
    pub fn start_user(&mut self, bank: &Bank, slot: usize, table: &UserTable) {
        let index = FACTORY_TABLES + slot;
        if let Some(job) = self.jobs.iter_mut().find(|j| j.index == index) {
            if let Source::User(old) = &job.source {
                if old.frames() == table.frames() {
                    for f in 0..table.frames() {
                        if old.frame(f) != table.frame(f) && !job.todo.contains(&f) {
                            job.todo.push(f);
                        }
                    }
                    job.source = Source::User(table.clone());
                    return;
                }
            }
            self.jobs.retain(|j| j.index != index);
        }
        let built = bank.user(slot);
        let (base, todo) = match bank.peek(index) {
            // Start from what is playing and redo only the frames that changed.
            Some(current) if built.frames() == table.frames() => {
                let todo: Vec<usize> = (0..table.frames()).filter(|&f| built.frame(f) != table.frame(f)).rev().collect();
                ((*current).clone(), todo)
            }
            _ => (Wavetable::empty(table.frames()), (0..table.frames()).rev().collect()),
        };
        if todo.is_empty() {
            return;
        }
        self.jobs.push(Job { index, table: base, source: Source::User(table.clone()), todo });
    }

    /// Builds up to `budget` frames. Returns the bank indices of the tables
    /// that were completed and installed.
    pub fn run(&mut self, bank: &mut Bank, budget: usize) -> Vec<usize> {
        let mut done = Vec::new();
        let mut left = budget;
        while left > 0 && !self.jobs.is_empty() {
            let work = self.work.get_or_insert_with(FrameBuilder::new);
            if self.cycle.len() != TABLE_SIZE {
                self.cycle = vec![0.0; TABLE_SIZE];
            }
            let job = &mut self.jobs[0];
            if let Some(f) = job.todo.pop() {
                match &job.source {
                    Source::Raw(raw) => self.cycle.copy_from_slice(&raw[f * TABLE_SIZE..(f + 1) * TABLE_SIZE]),
                    Source::User(user) => user.render(f, &mut self.cycle),
                }
                job.table.set_frame(work, f, &self.cycle);
                left -= 1;
            }
            if job.todo.is_empty() {
                let job = self.jobs.remove(0);
                let source = match &job.source {
                    Source::User(u) => Some(u),
                    Source::Raw(_) => None,
                };
                bank.install(job.index, Rc::new(job.table), source);
                done.push(job.index);
            }
        }
        done
    }
}
