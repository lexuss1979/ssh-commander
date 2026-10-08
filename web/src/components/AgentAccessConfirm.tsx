import { useEffect, useState } from 'react';
import { fetchProfilePrivileges } from '../api';
import type { ProfilePrivileges } from '../api';
import { Modal } from './Modal';
import { useT } from '../i18n';

interface Props {
  /** The dialogue's home profile — the privileges probe; null skips the probe. */
  homeProfileId: string | null;
  /** The WS frame is in flight: locked until the parent closes on approval_mode. */
  busy: boolean;
  /** "Enable": the parent sends set_approval_mode never + riskAcknowledged over the agent WS. */
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * The confirmation modal for enabling the 'never' access level of the
 * dialogue (docs/agent-access-levels-plan.md, revision v2). Lives in the
 * agent panel; lazily probes the dialogue home profile's privileges:
 * root/sudo (or a failed probe — fail-closed UX) show the strong warning
 * with the mandatory "I understand the risks" checkbox. While the probe is
 * in flight the whole decision is locked: the user must see the final
 * warning strength before acknowledging anything. No profile — the strong
 * warning too (the privileges are unknown). The submit goes through the
 * parent over the agent WS — the modal closes when the server confirms with
 * the approval_mode event. Cancel keeps the previous mode.
 */
export function AgentAccessConfirm({ homeProfileId, busy, onConfirm, onClose }: Props) {
  const { t } = useT();
  const [privileges, setPrivileges] = useState<ProfilePrivileges | null>(null);
  const [probeFailed, setProbeFailed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (!homeProfileId) return;
    let cancelled = false;
    fetchProfilePrivileges(homeProfileId)
      .then((p) => {
        if (!cancelled) setPrivileges(p);
      })
      .catch(() => {
        if (!cancelled) setProbeFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [homeProfileId]);

  // Escape closes the confirmation only (there is no other Escape handler
  // on the agent panel, but the menu dropdown and future ones must not act).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // The probe has been sent and has not answered yet — the decision is locked.
  const probePending = Boolean(homeProfileId) && !probeFailed && privileges === null;
  // Fail-closed: no profile, a failed probe, root or sudo all mean the strong
  // warning with the acknowledgement checkbox.
  const privileged = probeFailed || !homeProfileId || Boolean(privileges?.isRoot) || Boolean(privileges?.sudo);
  const canEnable = !busy && !probePending && (!privileged || acknowledged);

  return (
    <Modal title={t('agent.accessLevelConfirmTitle')} onClose={onClose}>
      {probeFailed ? (
        <p className="access-level-warning">{t('agent.accessLevelProbeFailed')}</p>
      ) : !homeProfileId ? (
        <p className="access-level-warning">{t('agent.accessLevelConfirmUnknown')}</p>
      ) : probePending ? (
        <p className="muted">{t('common.loading')}</p>
      ) : privileges!.isRoot || privileges!.sudo ? (
        <p className="access-level-warning">{t('agent.accessLevelConfirmRoot')}</p>
      ) : (
        <p className="muted">{t('agent.accessLevelConfirmGeneric')}</p>
      )}
      {privileged && !probePending && (
        <label className="access-level-ack">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          {t('agent.accessLevelRiskAck')}
        </label>
      )}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-danger" disabled={!canEnable} onClick={onConfirm}>
          {busy ? t('settings.saving') : t('agent.accessLevelEnable')}
        </button>
      </div>
    </Modal>
  );
}
