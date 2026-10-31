//! Incremental `text/event-stream` parser for engines that speak SSE.

#[derive(Default)]
pub struct SseParser {
    buffer: Vec<u8>,
    data: Vec<String>,
}

impl SseParser {
    /// Feeds a network chunk and returns the `data` of each completed frame.
    pub fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        while let Some(end) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = self.buffer.drain(..=end).collect();
            let text = String::from_utf8_lossy(&line);
            let text = text.trim_end_matches(['\n', '\r']);
            if text.is_empty() {
                if !self.data.is_empty() {
                    frames.push(self.data.join("\n"));
                    self.data.clear();
                }
            } else if let Some(value) = text.strip_prefix("data:") {
                self.data
                    .push(value.strip_prefix(' ').unwrap_or(value).to_owned());
            }
        }
        frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_span_chunks_and_multibyte_splits() {
        let mut parser = SseParser::default();
        let body = "id: 1\ndata: {\"a\":\"é\"}\n\n: keep\n\ndata: x\r\ndata: y\r\n\r\n".as_bytes();
        let (left, right) = body.split_at(14);
        let mut frames = parser.push(left);
        frames.extend(parser.push(right));
        assert_eq!(frames, vec!["{\"a\":\"é\"}", "x\ny"]);
    }
}
