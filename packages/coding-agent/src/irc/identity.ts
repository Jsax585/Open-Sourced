import type { UserMessage } from "@oh-my-pi/pi-ai";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

/** Transport provenance only; role and attribution retain their native meaning. */
export interface IrcSource {
	id: string;
	from: string;
	to: string;
	ts: number;
	replyTo?: string;
	wakeRelay?: boolean;
	fromParent?: boolean;
}

export type IrcSteeringMessage = UserMessage & { ircSource: IrcSource };

export function ircSource(message: IrcMessage, fromParent = false): IrcSource {
	return {
		id: message.id,
		from: message.from,
		to: message.to,
		ts: message.ts,
		...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
		...(message.wakeRelay ? { wakeRelay: true } : {}),
		...(fromParent ? { fromParent: true } : {}),
	};
}
