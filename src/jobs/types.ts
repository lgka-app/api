export interface JobResult {
  job: string;
  changed: boolean;
  hash?: string;
  error?: string;
  notes: string[];
}
