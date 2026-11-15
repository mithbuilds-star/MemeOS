export type InstagramAccount = {
  id: string; username: string; display_name: string | null;
  connection_status: string; discovery_enabled: boolean;
};
export type Meme = {
  id: string; extracted_text: string | null; classification: string;
  processing_status: string; source_permalink: string | null;
  source_username: string | null; asset_url?: string | null;
  created_at: string;
};
