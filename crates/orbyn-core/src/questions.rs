//! Questions an engine puts to the person. The row is durable; the waiter is the
//! engine's blocked request, which hears the answer, or nothing on a dismissal.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use orbyn_contracts::{Question, QuestionRequest, QuestionState};
use tokio::sync::oneshot;

use crate::error::{CoreError, Result};
use crate::store::Store;
use crate::util::new_id;

pub type Answers = BTreeMap<String, Vec<String>>;

/// `None` means dismissed, expired, or the run ended.
type Reply = oneshot::Sender<Option<Answers>>;

pub struct QuestionDesk {
    store: Arc<Store>,
    timeout: Duration,
    waiters: Mutex<HashMap<String, Reply>>,
}

impl QuestionDesk {
    pub fn new(store: Arc<Store>, timeout: Duration) -> Self {
        Self {
            store,
            timeout,
            waiters: Mutex::new(HashMap::new()),
        }
    }

    /// Opens a question and waits for the person. Anything but an answer, a
    /// failed write included, comes back as `None`.
    pub async fn ask(&self, run_id: &str, questions: Vec<Question>) -> Option<Answers> {
        // The waiter must exist before the row does, or a fast answer is lost.
        let id = new_id();
        let (reply, answer) = oneshot::channel();
        self.lock().insert(id.clone(), reply);
        if let Err(error) = self.store.create_question(&id, run_id, &questions) {
            tracing::debug!(%error, "could not open a question");
            self.lock().remove(&id);
            return None;
        }
        match tokio::time::timeout(self.timeout, answer).await {
            Ok(Ok(answers)) => answers,
            _ => {
                self.lock().remove(&id);
                let _ =
                    self.store
                        .settle_question(&id, QuestionState::Expired, None, "system:timeout");
                None
            }
        }
    }

    pub fn answer(&self, id: &str, answers: Answers, actor: &str) -> Result<QuestionRequest> {
        let request = self.store.question(id)?;
        for (key, values) in &answers {
            let question = request
                .questions
                .iter()
                .find(|question| question.id == *key)
                .ok_or_else(|| {
                    CoreError::Invalid("That question is not part of this request.".into())
                })?;
            if values.len() > 1 && !question.multi_select {
                return Err(CoreError::Invalid("That question takes one answer.".into()));
            }
        }
        if request
            .questions
            .iter()
            .any(|question| !answers.contains_key(&question.id))
        {
            return Err(CoreError::Invalid("Answer every question.".into()));
        }
        let settled =
            self.store
                .settle_question(id, QuestionState::Answered, Some(&answers), actor)?;
        self.wake(id, Some(answers));
        Ok(settled)
    }

    pub fn dismiss(&self, id: &str, actor: &str) -> Result<QuestionRequest> {
        let settled = self
            .store
            .settle_question(id, QuestionState::Dismissed, None, actor)?;
        self.wake(id, None);
        Ok(settled)
    }

    /// Closes every open question of a run so a blocked engine can stop.
    pub fn expire_run(&self, thread_id: &str, run_id: &str, actor: &str) -> Result<()> {
        let open = self
            .store
            .list_questions(Some(thread_id), Some(QuestionState::Pending))?;
        for request in open.into_iter().filter(|request| request.run_id == run_id) {
            match self
                .store
                .settle_question(&request.id, QuestionState::Expired, None, actor)
            {
                Ok(_) | Err(CoreError::QuestionClosed(_)) => self.wake(&request.id, None),
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn wake(&self, id: &str, answers: Option<Answers>) {
        if let Some(reply) = self.lock().remove(id) {
            let _ = reply.send(answers);
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Reply>> {
        self.waiters
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}
