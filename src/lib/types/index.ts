export type Banner = {
	id: string;
	type: string;
	title?: string;
	content: string;
	url?: string;
	dismissable?: boolean;
	timestamp: number;
};

export interface Params {
	stream_response: boolean | null;
	function_calling: string | boolean | null;
	seed: number | null;
	temperature: number | null;
	reasoning_effort: string | number | null;
	logit_bias: any | null;
	frequency_penalty: number | null;
	presence_penalty: number | null;
	repeat_penalty: number | null;
	repeat_last_n: number | null;
	mirostat: number | null;
	mirostat_eta: number | null;
	mirostat_tau: number | null;
	top_k: number | null;
	top_p: number | null;
	min_p: number | null;
	stop: string | string[] | null;
	tfs_z: number | null;
	num_ctx: number | null;
	num_batch: number | null;
	num_keep: number | null;
	max_tokens: number | null;
	num_gpu: number | null;
	use_mmap: boolean | undefined | null;
	use_mlock: boolean | undefined | null;
	num_thread: number | null;
	think: boolean | null;
	keep_alive: string | number | null;
	format: string | undefined | null;
	custom_params?: Record<string, any>;
}

export interface Filter {
	id: string;
	name: string;
	selected: boolean;
	is_global: boolean;
	meta: {
		description: string;
		[key: string]: any;
	};
	[key: string]: any;
}

export enum TTS_RESPONSE_SPLIT {
	PUNCTUATION = 'punctuation',
	PARAGRAPHS = 'paragraphs',
	NONE = 'none'
}