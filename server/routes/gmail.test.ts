import { describe, it, expect } from 'vitest';
import { mapAhead } from './gmail';

async function* range(n: number): AsyncGenerator<number> {
	for (let i = 0; i < n; i++) yield i;
}

describe('mapAhead', () => {
	it('yields results in INPUT order even when work finishes out of order', async () => {
		// Item 0 resolves slowest, the last item fastest — the opposite of completion order. The merge
		// downstream depends on this: results must still arrive 0,1,2,… so grouping matches a serial run.
		const fn = (i: number) => new Promise<number>(resolve => setTimeout(() => resolve(i), (10 - i) * 5));
		const out: number[] = [];
		for await (const r of mapAhead(range(10), 3, fn)) out.push(r);
		expect(out).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
	});

	it('never runs more than `depth` tasks concurrently', async () => {
		let active = 0, peak = 0;
		const fn = async (i: number) => {
			active++; peak = Math.max(peak, active);
			await new Promise(resolve => setTimeout(resolve, 5));
			active--; return i;
		};
		const out: number[] = [];
		for await (const r of mapAhead(range(12), 3, fn)) out.push(r);
		expect(out).toEqual([...Array(12).keys()]);
		expect(peak).toBeLessThanOrEqual(3);
	});

	it('handles a stream shorter than the window without dropping items', async () => {
		const out: number[] = [];
		for await (const r of mapAhead(range(2), 5, async (i) => i * 2)) out.push(r);
		expect(out).toEqual([0, 2]);
	});

	it('passes an empty stream through cleanly', async () => {
		const out: number[] = [];
		for await (const r of mapAhead(range(0), 3, async (i) => i)) out.push(r);
		expect(out).toEqual([]);
	});
});
