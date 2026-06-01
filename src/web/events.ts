/**
 * Global event bus for real-time agent monitoring.
 * Container runner emits events; web server broadcasts to WebSocket clients.
 *
 * Structured event protocol: container agent emits [EVENT] JSON lines on stderr.
 * Host parses these and broadcasts as typed events to dashboard/channels.
 */
import { EventEmitter } from 'events';

export interface AgentEvent {
  type:
    | 'agent:start'
    | 'agent:stdout'
    | 'agent:stderr'
    | 'agent:output'
    | 'agent:end'
    | 'agent:event' // Structured event from container
    | 'status';
  group: string;
  groupFolder: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Structured event types emitted by container agents via stderr.
 * Format: [EVENT] {"type":"...","content":"..."}
 */
export type StructuredEventType =
  // General agent events
  | 'thinking'
  | 'tool_call'
  | 'tool_result'
  | 'result'
  | 'log'
  // Subagent orchestration
  | 'subagent_start'
  | 'subagent_end'
  // Computation progress
  | 'computation_started'
  | 'scf_step'
  | 'md_step'
  | 'convergence_reached'
  | 'file_written'
  | 'computation_failed'
  // Intelligence pipeline
  | 'intelligence_phase'
  | 'expert_score'
  | 'data_collection_progress';

export interface StructuredEvent {
  type: StructuredEventType;
  timestamp?: string;
  content?: string;
  [key: string]: unknown;
}

/**
 * Parse a structured event from a stderr line.
 * Returns null if the line doesn't contain a structured event.
 * Format: [EVENT] {"type":"...","content":"..."}
 */
export function parseStructuredEvent(line: string): StructuredEvent | null {
  const match = line.match(
    /\[(?:agent-runner|EVENT)\]\s*\[EVENT\]\s*({.+})\s*$|^\[EVENT\]\s*({.+})\s*$/,
  );
  if (!match) return null;
  const json = match[1] || match[2];
  try {
    const event = JSON.parse(json);
    if (event && typeof event === 'object' && event.type) {
      return event as StructuredEvent;
    }
  } catch {
    // Not valid JSON
  }
  return null;
}

export const agentEvents = new EventEmitter();
