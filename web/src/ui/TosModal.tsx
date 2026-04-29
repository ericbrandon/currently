// First-launch Terms-of-Use modal. Blocks all app interaction behind a
// backdrop until the user clicks the agree button. Acceptance is keyed
// to TOS_VERSION in store.ts; on re-visits with a matching key, App
// skips rendering this entirely. See notes/TOS.md for the full plan and
// the verbatim TOS text below.

import { useEffect, useRef } from "preact/hooks";
import { acceptTos } from "../state/store";

export function TosModal() {
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    buttonRef.current?.focus();

    // Trap focus on the agree button (the only focusable element) and
    // swallow Escape so the modal can't be dismissed without consent.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div
      class="tos-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tos-title"
    >
      <div class="tos-modal">
        <h2 id="tos-title" class="tos-title">Terms of Use</h2>
        <div class="tos-scroll">
          <p class="tos-last-updated"><strong>Last updated: April 28, 2026</strong></p>

          <p>
            By using this site, you agree to the following terms. If you do not
            agree, please do not use the site.
          </p>

          <h3>1. About this site</h3>
          <p>
            This is an <strong>experimental hobby project</strong>, provided
            free of charge with no commercial purpose. It is not affiliated
            with, endorsed by, or sponsored by the Canadian Hydrographic
            Service (CHS), Fisheries and Oceans Canada, or any government
            agency.
          </p>

          <h3>2. Not for navigation</h3>
          <p>
            <strong>
              This site must not be used for navigation, vessel routing, voyage
              planning, or any decision affecting the safety of life or
              property at sea.
            </strong>{" "}
            Mariners must consult official, current CHS publications, charts,
            and tide and current tables, and must use properly maintained
            navigational equipment.
          </p>

          <h3>3. No warranty</h3>
          <p>
            The site and all information it presents — including tide
            predictions, current predictions, station locations, timings, and
            derived values — are provided{" "}
            <strong>"as is" and "as available," without warranties of any
            kind</strong>, express or implied. We make no representations as to
            accuracy, completeness, timeliness, reliability, or fitness for any
            particular purpose. Data may be incorrect, out of date, or missing,
            and predictions may differ materially from actual conditions.
          </p>

          <h3>4. Assumption of risk</h3>
          <p>
            <strong>You use this site entirely at your own risk.</strong> You
            are solely responsible for any decisions you make and any
            consequences that follow from using the information presented here.
            If you are on or near the water, you accept all risks associated
            with marine activity.
          </p>

          <h3>5. Limitation of liability</h3>
          <p>
            To the fullest extent permitted by law, the operator of this site
            shall not be liable for any direct, indirect, incidental,
            consequential, special, exemplary, or punitive damages — including
            loss of life, personal injury, property damage, loss of use, or
            economic loss — arising out of or in connection with your use of,
            or inability to use, this site, even if advised of the possibility
            of such damages.
          </p>

          <h3>6. Indemnification</h3>
          <p>
            You agree to indemnify and hold harmless the operator from any
            claim, demand, loss, or liability arising out of your use of the
            site or your breach of these terms.
          </p>

          <h3>7. Changes</h3>
          <p>
            These terms may be updated at any time. Continued use of the site
            after changes constitutes acceptance of the revised terms.
          </p>

          <h3>8. Governing law</h3>
          <p>
            These terms are governed by the laws of the Province of British
            Columbia and the federal laws of Canada applicable therein. Any
            dispute shall be subject to the exclusive jurisdiction of the
            courts of British Columbia.
          </p>
        </div>

        <div class="tos-consent">
          <p>
            By clicking <strong>"I have read and agree to the Terms of
            Use"</strong> below, you confirm that you have read, understood,
            and agree to be bound by the Terms of Use above, including the
            disclaimers of warranty, the limitation of liability, and the
            warning that this site{" "}
            <strong>must not be used for navigation</strong>.
          </p>
          <button
            ref={buttonRef}
            class="tos-agree"
            type="button"
            onClick={acceptTos}
          >
            I have read and agree to the Terms of Use
          </button>
        </div>
      </div>
    </div>
  );
}
