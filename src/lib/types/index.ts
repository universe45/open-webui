export type Banner = {
	id: string;
	type: string;
	title?: string;
	content: string;
	url?: string;
	dismissable?: boolean;
	timestamp: number;
};

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