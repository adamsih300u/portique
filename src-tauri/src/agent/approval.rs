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
    /// The dialog also asks for the master password.
    pub password: bool,
    /// Whether this is a real "may I?" (the profile asks for each step) rather than only the password.
    pub confirm: bool,
}

#[derive(Default)]
pub struct Approvals {
    pending: Mutex<HashMap<String, Pending>>,
}

struct Pending {
    tx: oneshot::Sender<Decision>,
    /// Wrong passwords tried against this question.
    wrong: u8,
    /// Only a password that checked out may grant this question (see `answer_verified`).
    needs_password: bool,
}

/// Wrong passwords a question puts up with before it counts as a no.
pub const MAX_WRONG: u8 = 5;

struct Cleanup<'a> {
    approvals: &'a Approvals,
    host: &'a dyn Host,
    id: &'a str,
}

impl Drop for Cleanup<'_> {
    fn drop(&mut self) {
        self.approvals.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(self.id);
        self.host.emit("agent-approval-closed", json!({ "id": self.id }));
    }
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
            pending.insert(id.clone(), Pending { tx, wrong: 0, needs_password: q.password });
        }
        host.emit(
            "agent-approval",
            json!({
                "id": id, "kind": q.kind, "client": q.client, "profile": q.profile, "session": q.session, "text": q.text,
                "password": q.password, "confirm": q.confirm,
            }),
        );
        host.attention();
        // However this call ends (an answer, a timeout, or the agent hanging up and the call being dropped), the
        // question is taken off the list and the page is told to drop its dialog.
        let _cleanup = Cleanup { approvals: self, host, id: &id };
        match tokio::time::timeout(patience, rx).await {
            Ok(Ok(d)) => Outcome::Decided(d),
            Ok(Err(_)) => Outcome::Decided(Decision::Deny), // withdrawn
            Err(_) => Outcome::TimedOut,
        }
    }

    /// The person's answer. False when the question is gone (timed out, or already answered), and for a yes to a question
    /// that wants the master password: only `answer_verified` may grant that, after the password has been checked.
    pub fn answer(&self, id: &str, decision: Decision) -> bool {
        let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
        if decision != Decision::Deny && pending.get(id).is_some_and(|p| p.needs_password) {
            return false;
        }
        pending.remove(id).is_some_and(|p| p.tx.send(decision).is_ok())
    }

    /// Answers a question whose password has just been checked.
    pub fn answer_verified(&self, id: &str, decision: Decision) -> bool {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).remove(id).is_some_and(|p| p.tx.send(decision).is_ok())
    }

    /// Whether the question is still waiting for an answer.
    pub fn is_waiting(&self, id: &str) -> bool {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).contains_key(id)
    }

    /// Notes a wrong password and returns how many this question has had.
    pub fn wrong_password(&self, id: &str) -> u8 {
        self.pending.lock().unwrap_or_else(|p| p.into_inner()).get_mut(id).map_or(0, |p| {
            p.wrong += 1;
            p.wrong
        })
    }

    /// Answers every waiting question with a no (when agent access is switched off).
    pub fn deny_all(&self) {
        for (_, p) in self.pending.lock().unwrap_or_else(|p| p.into_inner()).drain() {
            let _ = p.tx.send(Decision::Deny);
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
        Question { kind: Kind::Command, client: "claude-code", profile: "web1", session: Some("s1"), text, password: false, confirm: true }
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
    async fn a_call_that_is_dropped_while_waiting_frees_its_slot_and_closes_the_dialog() {
        let host = Arc::new(FakeHost::default());
        let a = Arc::new(Approvals::default());
        let task = tokio::spawn({
            let (host, a) = (host.clone(), a.clone());
            async move { a.ask(&*host, q("ls"), PATIENCE).await }
        });
        asked(&host).await;
        assert_eq!(a.waiting(), 1);
        task.abort(); // the agent hung up
        let _ = task.await;
        assert_eq!(a.waiting(), 0, "the slot is free again");
        assert_eq!(host.events("agent-approval-closed").len(), 1, "the page is told to drop the dialog");
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
