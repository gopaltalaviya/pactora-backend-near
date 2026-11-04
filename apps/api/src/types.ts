export interface AgentRow {
  id: number;
  chainId: number;
  chainAgentId: string | null;
  name: string;
  description: string | null;
  walletAddress: string;
  ownerAddress: string;
  pricePerTask: string;
  stake: string;
  active: boolean;
  endpointUrl: string | null;
  capabilities?: string[];
  score?: number | null;
  completed?: number | null;
  failed?: number | null;
  lastActiveAt?: string | Date | null;
}
