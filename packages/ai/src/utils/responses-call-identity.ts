export interface ResponsesCallIdentity {
	callId: string;
	itemId?: string;
	type?: string;
}

/** Read the original item identity, without generating or normalizing an ID. */
export function responsesItemComponent(id: string): string | undefined {
	const separator = id.indexOf("|");
	return separator > 0 && separator < id.length - 1 ? id.slice(separator + 1) : undefined;
}

interface IndexQueue {
	indices: number[];
	next: number;
}

interface IdentityBucket {
	all: IndexQueue;
	anonymous: IndexQueue;
	byItemId: Map<string, IndexQueue>;
}

function identityKey(identity: ResponsesCallIdentity): string {
	return `${identity.type ?? ""}\0${identity.callId}`;
}

/**
 * Match each call to at most one native item. Reserve all exact item identities
 * before occurrence fallback, so an anonymous call cannot steal a named sibling.
 * Distinct, nonempty item IDs are never treated as the same invocation.
 */
export function matchResponsesCallIdentities(
	calls: readonly ResponsesCallIdentity[],
	nativeItems: readonly ResponsesCallIdentity[],
): Array<number | undefined> {
	const matches: Array<number | undefined> = [];
	matches.length = calls.length;
	if (calls.length === 0 || nativeItems.length === 0) return matches;
	const buckets = new Map<string, IdentityBucket>();
	for (let index = 0; index < nativeItems.length; index++) {
		const item = nativeItems[index]!;
		const key = identityKey(item);
		let bucket = buckets.get(key);
		if (!bucket) {
			bucket = { all: { indices: [], next: 0 }, anonymous: { indices: [], next: 0 }, byItemId: new Map() };
			buckets.set(key, bucket);
		}
		bucket.all.indices.push(index);
		if (item.itemId) {
			const queue = bucket.byItemId.get(item.itemId);
			if (queue) queue.indices.push(index);
			else bucket.byItemId.set(item.itemId, { indices: [index], next: 0 });
		} else {
			bucket.anonymous.indices.push(index);
		}
	}

	const used = new Uint8Array(nativeItems.length);
	for (let index = 0; index < calls.length; index++) {
		const call = calls[index]!;
		if (!call.itemId) continue;
		const queue = buckets.get(identityKey(call))?.byItemId.get(call.itemId);
		if (!queue || queue.next === queue.indices.length) continue;
		const match = queue.indices[queue.next++]!;
		matches[index] = match;
		used[match] = 1;
	}
	for (let index = 0; index < calls.length; index++) {
		if (matches[index] !== undefined) continue;
		const call = calls[index]!;
		const bucket = buckets.get(identityKey(call));
		if (!bucket) continue;
		const queue = call.itemId ? bucket.anonymous : bucket.all;
		while (queue.next < queue.indices.length && used[queue.indices[queue.next]!] !== 0) queue.next++;
		if (queue.next === queue.indices.length) continue;
		const match = queue.indices[queue.next++]!;
		matches[index] = match;
		used[match] = 1;
	}
	return matches;
}
