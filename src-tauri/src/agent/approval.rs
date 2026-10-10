//! Questions put to the person: may the agent open this, run that, type this? The page shows them as
//! dialogs; the agent's tool call waits for the answer.

use super::Host;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tokio::sync::oneshot;

/// How long a question waits before it counts as a no.
pub const PATIENCE: Duration = Duration::from_secs(120);
/// Questions waiting at once. More are refused, so an agent cannot bury the person in dialogs.
const MAX_PENDING: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    /// Open a session on a profile.
    Open,
    /// Run a command in a session.
    Command,
    /// Type keys or text into a session.
    Input,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Decision {
    Deny,
    /// Yes, this once. For an open: yes, but ask again for each command.
    Once,
    /// Yes, and stop asking in this session.
    Session,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Decided(Decision),
    TimedOut,
    /// Too many questions are already waiting.
    Crowded,
}

pub struct Question<'a> {
    pub kind: Kind,
    /// The agent, as it named itself.
    pub client: &'a str,
    /// The profile's name, for the dialog.
    pub profile: &'a str,
    pub session: Option<&'a str>,
    /// What would run or be typed, exactly.
    pub text: &'a str,
}

#[derive(Default)]
pub struct Approvals {
    pending: Mutex<HashMap<String, oneshot::Sender<Decision>>>,
}

impl Approvals {
    pub async fn ask(&self, host: &dyn Host, q: Question<'_>, patience: Duration) -> Outcome {
        let id = super::exec::nonce();
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
            if pending.len() >= MAX_PENDING {
                return Outcome::Crowded;
            }
            pending.insert(id.clone(), tx);
        }
        host.emit(
            "agent-approval",
            json!({ "id": id, "kind": q.kind, "client": q.client, "profile": q.profile, "session": q.session, "text": q.text }),
        );
        host.attention();
        let outcome = match tokio::time::timeout(patience, rx).await {
            Ok(Ok(d)) => Outcome::Decided(d),
            Ok(Err(_)) => Outcome::Decided(Decision::Deny), // withdrawn
            Err(_) => Outcome::TimedOut,
        };
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(&id);
        // Tells the page to drop the dialog if nobody answered it.
        host.emit("agent-approval-closed", json!({ "id": id }));
        outcome
    }

    /// The person's answer. False when the question is gone (timed out, or already answered).
    pub fn answer(&self, id: &str, decision: Decision) -> bool {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(id).is_some_and(|tx| tx.send(decision).is_ok())
    }

    /// Answers every waiting question with a no (when agent access is switched off).
    pub fn deny_all(&self) {
        for (_, tx) in self.pending.lock().unwrap_or_else(|p| p.into_inner()).drain() {
            let _ = tx.send(Decision::Deny);
        }
    }

    #[cfg(test)]
    pub fn waiting(&self) -> usize {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::testing::FakeHost;
    use std::sync::Arc;

    fn q(text: &str) -> Question<'_> {
        Question { kind: Kind::Command, client: "claude-code", profile: "web1", session: Some("s1"), text }
    }

    /// Waits until the question is on the page, and returns its id.
    async fn asked(host: &FakeHost) -> String {
        for _ in 0..200 {
            if let Some(e) = host.events("agent-approval").pop() {
                return e["id"].as_str().unwrap().to_string();
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("no question was shown");
    }

    #[tokio::test]
    async fn the_page_is_asked_and_the_answer_comes_back() {
        let host = Arc::new(FakeHost::default());
        let a = Arc::new(Approvals::default());
        let task = tokio::spawn({
            let (host, a) = (host.clone(), a.clone());
            async move { a.ask(&*host, q("rm -rf build"), PATIENCE).await }
        });
        let id = asked(&host).await;
        let shown = host.events("agent-approval").pop().unwrap();
        assert_eq!((shown["text"].as_str(), shown["kind"].as_str(), shown["client"].as_str()), (Some("rm -rf build"), Some("command"), Some("claude-code")));
        assert_eq!(a.waiting(), 1);
        assert!(a.answer(&id, Decision::Session));
        assert_eq!(task.await.unwrap(), Outcome::Decided(Decision::Session));
        assert_eq!(a.waiting(), 0);
        assert_eq!(host.events("agent-approval-closed").len(), 1);
        assert!(!a.answer(&id, Decision::Once), "a question is answered once");
    }

    #[tokio::test]
    async fn no_answer_in_time_is_a_no() {
        let host = FakeHost::default();
        let a = Approvals::default();
        assert_eq!(a.ask(&host, q("ls"), Duration::from_millis(30)).await, Outcome::TimedOut);
        assert_eq!(a.waiting(), 0);
    }

    #[tokio::test]
    async fn switching_access_off_denies_everything_waiting() {
        let host = Arc::new(FakeHost::default());
        let a = Arc::new(Approvals::default());
        let task = tokio::spawn({
            let (host, a) = (host.clone(), a.clone());
            async move { a.ask(&*host, q("ls"), PATIENCE).await }
        });
        asked(&host).await;
        a.deny_all();
        assert_eq!(task.await.unwrap(), Outcome::Decided(Decision::Deny));
    }

    #[tokio::test]
    async fn too_many_waiting_questions_are_refused() {
        let host = Arc::new(FakeHost::default());
        let a = Arc::new(Approvals::default());
        let tasks: Vec<_> = (0..MAX_PENDING)
            .map(|_| {
                let (host, a) = (host.clone(), a.clone());
                tokio::spawn(async move { a.ask(&*host, q("ls"), PATIENCE).await })
            })
            .collect();
        while a.waiting() < MAX_PENDING {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(a.ask(&*host, q("one more"), PATIENCE).await, Outcome::Crowded);
        a.deny_all();
        for t in tasks {
            t.await.unwrap();
        }
    }
}
