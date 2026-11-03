<script lang="ts">
	/**
	 * Sandbox profiles: what each one allows, side by side. The names are the
	 * ones the CLI and `/sandbox` accept, so the sample doubles as a reference.
	 */
	import MockFrame from './MockFrame.svelte';
	import { sandboxRows, toneClass } from './data';
</script>

<MockFrame label="$ alnair --sandbox" bleed>
	<table>
		<thead>
			<tr>
				<th scope="col">profile</th>
				<th scope="col">files</th>
				<th scope="col">net</th>
			</tr>
		</thead>
		<tbody>
			{#each sandboxRows as row (row.profile)}
				<tr>
					<td class={toneClass[row.tone]}>{row.profile}</td>
					<td>{row.files}</td>
					<td class:blocked={row.network === 'blocked'}>{row.network}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</MockFrame>

<style>
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.625rem;
	}

	th {
		padding: 0.375rem 0.625rem 0.25rem;
		text-align: left;
		font-weight: 400;
		color: var(--ink-tertiary);
		font-size: 0.5625rem;
		letter-spacing: 0.04em;
	}

	th:first-child {
		padding-left: 0.625rem;
	}

	td {
		padding: 0.25rem 0.625rem;
		color: var(--ink-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.blocked {
		color: var(--accent-success);
	}
</style>
