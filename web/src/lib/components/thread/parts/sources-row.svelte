<script lang="ts">
	import LinkIcon from '@lucide/svelte/icons/link';
	import * as HoverCard from '#lib/components/ui/hover-card/index.js';
	import * as Trace from '#lib/components/ui/trace/index.js';
	import type { SourcesPart } from '#lib/harness/types.js';

	let { part }: { part: SourcesPart } = $props();
</script>

<Trace.Root>
	<Trace.Collapsible>
		<Trace.CollapsibleTrigger>
			<Trace.Line>
				<Trace.Icon>
					<LinkIcon class="text-system" />
				</Trace.Icon>
				<Trace.Title>{part.title}</Trace.Title>
				<Trace.Description class="tabular">{part.sources.length}</Trace.Description>
			</Trace.Line>
		</Trace.CollapsibleTrigger>
		<Trace.CollapsibleContent class="border-line/80">
			<ul class="flex flex-col gap-1.5">
				{#each part.sources as source (source.id)}
					<li>
						<HoverCard.Root>
							<HoverCard.Trigger>
								{#snippet child({ props })}
									<!-- eslint-disable svelte/no-navigation-without-resolve -- citations are external absolute URLs, not app routes -->
									<a
										{...props}
										href={source.url}
										target="_blank"
										rel="noreferrer"
										class="group flex items-baseline gap-2 rounded-sm text-[13px] text-ink-secondary hover:text-ink"
									>
										<span class="tabular font-mono text-[10px] text-ink-tertiary"
											>{part.sources.indexOf(source) + 1}</span
										>
										<span
											class="min-w-0 truncate group-hover:underline group-hover:underline-offset-2"
										>
											{source.title}
										</span>
										<span class="shrink-0 text-[11px] text-ink-tertiary">{source.host}</span>
									</a>
									<!-- eslint-enable svelte/no-navigation-without-resolve -->
								{/snippet}
							</HoverCard.Trigger>
							<HoverCard.Content class="w-72">
								<p class="text-[13px] font-medium">{source.title}</p>
								<p class="mt-1 font-mono text-[11px] break-all text-ink-tertiary">{source.url}</p>
								{#if source.snippet}
									<p class="mt-2 text-[12.5px] leading-relaxed text-ink-secondary">
										{source.snippet}
									</p>
								{/if}
							</HoverCard.Content>
						</HoverCard.Root>
					</li>
				{/each}
			</ul>
		</Trace.CollapsibleContent>
	</Trace.Collapsible>
</Trace.Root>
