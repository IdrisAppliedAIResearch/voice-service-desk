export interface Article {
  slug: string;
  title: string;
  category: string;
  tags: string[];
  updated: string;
  topic: string;
  body: string;
}

export interface KbChunk {
  articleId: number;
  slug: string;
  title: string;
  updated: string;
  text: string;
  score: number;
}
