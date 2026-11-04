/**
 * The document viewer hands a file's bytes to this worker, which answers with a
 * parsed document or a refusal with its own reason. The parsing happens here so
 * a large document cannot block typing in the app, and the whole protocol is
 * the two types `office.ts` owns.
 */

import { respondToOfficeRequest, type OfficeRequest, type OfficeResponse } from "./office";

/** The little of this file's own global that it uses. */
interface WorkerScope {
  postMessage(message: OfficeResponse): void;
  addEventListener(type: "message", listener: (event: MessageEvent<OfficeRequest>) => void): void;
}

const scope = self as unknown as WorkerScope;

/** Every request gets an answer, a refusal included: a throw would lose the reason. */
async function answer(request: OfficeRequest): Promise<void> {
  scope.postMessage(await respondToOfficeRequest(request));
}

scope.addEventListener("message", (event) => {
  void answer(event.data);
});
