//! The service's worker threads, joined when the set is dropped. Each
//! watches the same stop, which the drop raises first: on the way out of a
//! start that failed half way, nothing waits on a worker that was never
//! told to end.

use std::sync::Arc;
use std::thread::JoinHandle;

use crate::core::shared::Shared;
use crate::util::Shutdown;

pub struct Workers {
    shared: Arc<Shared>,
    stop: Shutdown,
    running: Vec<JoinHandle<()>>,
}

impl Workers {
    pub fn new(shared: &Arc<Shared>, stop: &Shutdown) -> Self {
        Self {
            shared: Arc::clone(shared),
            stop: stop.clone(),
            running: Vec::new(),
        }
    }

    /// Start a named worker with the shared state and the stop
    /// (`util::spawn_worker`).
    pub fn spawn(
        &mut self,
        name: &str,
        work: impl FnOnce(Arc<Shared>, Shutdown) + Send + 'static,
    ) -> std::io::Result<()> {
        let handle = crate::util::spawn_worker(name, &self.shared, &self.stop, work)?;
        self.running.push(handle);
        Ok(())
    }
}

impl Drop for Workers {
    /// The newest first.
    fn drop(&mut self) {
        self.stop.stop();
        while let Some(h) = self.running.pop() {
            let _ = h.join();
        }
    }
}
