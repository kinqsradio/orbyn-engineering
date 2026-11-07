import "./platform.css";
import { AccountCard } from "./AccountCard";
import { ConnectPlanner } from "./ConnectPlanner";
import { PairPhone } from "./PairPhone";
import { PhoneOffline } from "./PhoneOffline";
import { PhoneView } from "./PhoneView";
import type { PreviewScreenName } from "./previews";
import { sampleAccount, sampleConsent, samplePairing, samplePhoneApproval, samplePhoneThreads } from "./sample";

/** Loaded only through `previews.ts`, so a production build never includes it. */
export default function PreviewScreens({ name }: { name: PreviewScreenName }) {
  switch (name) {
    case "account":
      return <AccountCard account={sampleAccount} />;
    case "connect-planner":
      return <ConnectPlanner consent={sampleConsent} />;
    case "pair-phone":
      return <PairPhone offer={samplePairing} />;
    case "phone":
      return <PhoneView threads={samplePhoneThreads} approval={samplePhoneApproval} />;
    case "phone-offline":
      return <PhoneOffline />;
  }
}
