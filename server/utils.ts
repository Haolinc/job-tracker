export const errMsg = (e: unknown, fallback: string): string => {
	if (e instanceof Error) return e.message;
	if (typeof e === 'string') return e;
	return fallback;
};
