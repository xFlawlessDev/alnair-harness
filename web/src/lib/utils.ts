export { cn } from 'cn';

/** An element-ref prop paired with the attributes of the rendered element. */
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & {
	ref?: U | null;
};

/** The props of a primitive, minus its own `child` snippet. */
export type WithoutChild<T> = T extends { child?: unknown } ? Omit<T, 'child'> : T;

/** The props of a primitive, minus its own `children` snippet. */
export type WithoutChildren<T> = T extends { children?: unknown } ? Omit<T, 'children'> : T;

/** The props of a primitive, minus its own `child` and `children` snippets. */
export type WithoutChildrenOrChild<T> = T extends { children?: unknown }
	? Omit<WithoutChild<T>, 'children'>
	: WithoutChild<T>;
