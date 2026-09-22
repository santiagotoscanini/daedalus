//! Placeholder until the platform collector lands.
use super::{Collect, Sample, Static};

#[derive(Default)]
pub struct Collector;

impl Collect for Collector {
    fn read_static(&mut self) -> Static {
        Static::default()
    }
    fn sample(&mut self) -> Sample {
        Sample::default()
    }
}
