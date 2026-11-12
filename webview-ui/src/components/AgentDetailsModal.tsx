import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  AGENT_DETAILS_POLL_MS,
  AGENT_DETAILS_SPRITE_REFRESH_MS,
  AGENT_DETAILS_SPRITE_ZOOM,
  AGENT_DETAILS_STICK_BOTTOM_PX,
} from '../constants.js';
import { getCharacterSprite } from '../office/engine/characters.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { getCachedSprite } from '../office/sprites/spriteCache.js';
import { getCharacterSprites } from '../office/sprites/spriteData.js';
import { transport } from '../transport/index.js';
import { Modal } from './ui/Modal.js';

// Mirrors server/src/agentDetails.ts (the payload is opaque to the protocol, like
// the diagnostics one, so the webview declares the shape it reads).
interface ChatEntry {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  at: number;
}

interface AgentDetails {
  found: boolean;
  sessionId?: string;
  cwd?: string;
  pid?: number;
  alive?: boolean | null;
  status?: string;
  statusSince?: number;
  startedAt?: number;
  lastActivityAt?: number;
  agentName?: string;
  teamName?: string;
  isTeamLead?: boolean;
  contextTokens?: number;
  maxContextTokens?: number;
  transcriptFile?: string;
  truncated?: boolean;
  chat?: ChatEntry[];
}

interface AgentDetailsModalProps {
  /** The agent whose details are shown; null keeps the dialog closed. */
  agentId: number | null;
  officeState: OfficeState;
  onClose: () => void;
}

/** "3 d 4 h", "12 min", "45 s": the two largest units, so it stays short. */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

/** "08:20 pm 26/11": 12-hour clock then day/month, fixed so it never depends on the browser locale. */
function formatStamp(ms: number): string {
  if (ms <= 0) return '';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hour12 = d.getHours() % 12 || 12;
  const meridiem = d.getHours() < 12 ? 'am' : 'pm';
  return `${pad(hour12)}:${pad(d.getMinutes())} ${meridiem} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`;
}

const STATUS_LABEL: Record<string, string> = {
  busy: 'Working',
  idle: 'Resting',
  shell: 'Running a shell command',
};

/** The character's live sprite, redrawn on an interval so the frame it is
 *  really on (typing, reading, walking, standing) is what the reader sees. */
function LiveSprite({ agentId, officeState }: { agentId: number; officeState: OfficeState }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const draw = () => {
      const canvas = canvasRef.current;
      const ch = officeState.characters.get(agentId);
      if (!canvas || !ch) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const sprite = getCharacterSprite(ch, getCharacterSprites(ch.palette, ch.hueShift));
      const img = getCachedSprite(sprite, AGENT_DETAILS_SPRITE_ZOOM);
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
    };
    draw();
    const timer = setInterval(draw, AGENT_DETAILS_SPRITE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [agentId, officeState]);

  return <canvas ref={canvasRef} style={{ imageRendering: 'pixelated' }} />;
}

function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="flex gap-8 text-base leading-tight min-w-0" title={title ?? value}>
      <span className="text-text-muted shrink-0 w-[90px]">{label}</span>
      <span className="break-all min-w-0">{value}</span>
    </div>
  );
}

function ChatLine({ entry }: { entry: ChatEntry }) {
  if (entry.role === 'tool') {
    return (
      <div className="text-sm text-text-muted opacity-80 px-8 break-words whitespace-pre-wrap">
        {'> '}
        {entry.text}
      </div>
    );
  }
  const isUser = entry.role === 'user';
  return (
    <div
      className={`border-2 py-6 px-8 ${isUser ? 'border-accent bg-active-bg' : 'border-agent-border bg-agent-bg'}`}
    >
      <div className="flex justify-between text-sm mb-4">
        <span className={isUser ? 'text-accent-bright' : 'text-status-success'}>
          {isUser ? 'You' : 'Agent'}
        </span>
        <span className="text-text-muted">{formatStamp(entry.at)}</span>
      </div>
      <div className="text-base break-words whitespace-pre-wrap">{entry.text}</div>
    </div>
  );
}

export function AgentDetailsModal({ agentId, officeState, onClose }: AgentDetailsModalProps) {
  const [details, setDetails] = useState<AgentDetails | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // The owner of a sub-agent character is the real session behind it.
  const targetId = agentId === null ? null : officeState.terminalOwnerOf(agentId);

  // Poll while open. A different agent starts from a clean slate so the previous
  // one's conversation never shows under the new header.
  useEffect(() => {
    if (targetId === null) return;
    setDetails(null);
    stickToBottomRef.current = true;
    const request = () => transport.send({ type: 'requestAgentDetails', id: targetId });
    request();
    const poll = setInterval(request, AGENT_DETAILS_POLL_MS);
    const unsubscribe = transport.onMessage((msg) => {
      if (msg.type === 'agentDetails' && msg.id === targetId) {
        setDetails(msg.details as AgentDetails);
      }
    });
    return () => {
      clearInterval(poll);
      unsubscribe();
    };
  }, [targetId]);

  // Tick once a second so "for 12 min" counts up between polls.
  useEffect(() => {
    if (targetId === null) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [targetId]);

  // Follow new messages only while the reader is already at the bottom.
  const chatLength = details?.chat?.length ?? 0;
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [chatLength, details?.lastActivityAt]);

  if (targetId === null) return null;

  const ch = officeState.characters.get(targetId);
  const label =
    details?.agentName ??
    (ch?.directoryName ? `${ch.directoryName} · #${targetId}` : `Agent #${targetId}`);
  const statusText = details?.status ? (STATUS_LABEL[details.status] ?? details.status) : 'Unknown';
  const sinceText = details?.statusSince ? ` for ${formatDuration(now - details.statusSince)}` : '';
  const aliveText =
    details?.alive === false
      ? 'Not running'
      : details?.pid !== undefined
        ? `${details.pid}`
        : details?.alive === null
          ? 'Unknown (no CLI registry)'
          : '-';

  return (
    <Modal isOpen onClose={onClose} title={label} className="w-[900px]">
      {!details ? (
        <div className="py-20 text-center text-text-muted">Loading...</div>
      ) : !details.found ? (
        <div className="py-20 text-center text-text-muted">This agent is no longer tracked.</div>
      ) : (
        <div className="flex flex-col gap-10">
          <div className="flex gap-12 items-start border-2 border-border bg-bg-dark p-8">
            <div className="flex flex-col gap-4 min-w-0 flex-1">
              <Fact label="Folder" value={details.cwd ?? '-'} />
              <Fact label="PID" value={aliveText} />
              <Fact
                label="State"
                value={`${details.alive === false ? 'Closed' : statusText}${details.alive === false ? '' : sinceText}`}
              />
              {details.startedAt ? (
                <Fact
                  label="Process up"
                  value={formatDuration(now - details.startedAt)}
                  title={new Date(details.startedAt).toLocaleString()}
                />
              ) : null}
              {details.lastActivityAt ? (
                <Fact
                  label="Last msg"
                  value={`${formatDuration(now - details.lastActivityAt)} ago`}
                  title={new Date(details.lastActivityAt).toLocaleString()}
                />
              ) : null}
              {details.teamName ? (
                <Fact
                  label="Team"
                  value={`${details.teamName}${details.isTeamLead ? ' (lead)' : ''}`}
                />
              ) : null}
              {details.maxContextTokens ? (
                <Fact
                  label="Context"
                  value={`${Math.round(((details.contextTokens ?? 0) / details.maxContextTokens) * 100)}% of window`}
                />
              ) : null}
              <Fact label="Session" value={details.sessionId ?? '-'} />
            </div>
            <div className="shrink-0 flex items-end justify-center">
              <LiveSprite agentId={targetId} officeState={officeState} />
            </div>
          </div>

          <div
            ref={scrollRef}
            className="flex flex-col gap-6 overflow-y-auto h-[420px] pr-4"
            onScroll={(e) => {
              const el = e.currentTarget;
              stickToBottomRef.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < AGENT_DETAILS_STICK_BOTTOM_PX;
            }}
          >
            {details.truncated && (
              <div className="text-sm text-text-muted text-center">
                Older messages are not shown.
              </div>
            )}
            {(details.chat ?? []).length === 0 ? (
              <div className="py-20 text-center text-text-muted">No messages yet.</div>
            ) : (
              (details.chat ?? []).map((entry, i) => <ChatLine key={i} entry={entry} />)
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
