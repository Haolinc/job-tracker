/** True when `url` answers HTTP OK within the timeout; false on any error or timeout. */
export async function isReachable(url: string, timeoutMs = 1500): Promise<boolean> {
	try {
		return (await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })).ok;
	} catch {
		return false;
	}
}
