// Chunk size/overlap match the legacy ingestFile production settings.
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import type { TextSplitter } from '@app/domain';

const splitter = new RecursiveCharacterTextSplitter({
  chunkSize: 350,
  chunkOverlap: 50,
});

export const langchainSplitter: TextSplitter = {
  async splitText(text: string): Promise<string[]> {
    return splitter.splitText(text);
  },
};
