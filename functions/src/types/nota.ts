export interface PublishedNota {
  id: string
  title: string
  content: string | null
  updatedAt: string
  publishedAt: string
  authorId: string
  authorName: string
  isPublic: boolean
  isSubPage?: boolean
  parentId?: string | null
  publishedSubPages?: string[]
  citations?: CitationEntry[]
  // Statistics fields
  viewCount?: number
  uniqueViewers?: number
  lastViewedAt?: string
  referrers?: { [source: string]: number }
  tags?: string[]
  stats?: {
    dailyViews?: { [date: string]: number }
    weeklyViews?: { [week: string]: number }
    monthlyViews?: { [month: string]: number }
  }
  // Voting fields
  likeCount?: number
  dislikeCount?: number
  cloneCount?: number
  // Comment counts
  commentCount?: number
  votes?: {
    [userId: string]: NotaVoteType
  }
}

export type NotaVoteType = 'like' | 'dislike'

export interface CitationEntry {
  id: string
  key: string
  title: string
  authors: string[]
  year: string
  journal?: string
  volume?: string
  number?: string
  pages?: string
  publisher?: string
  url?: string
  doi?: string
  createdAt: Date | string
}

// Comment interfaces for public notas
export interface Comment {
  id: string
  notaId: string
  content: string
  authorId: string
  authorName: string
  authorTag?: string
  createdAt: string
  updatedAt: string
  parentId: string | null
  likeCount: number
  dislikeCount: number
  replyCount: number
  // Map of user votes (userId: 'like' | 'dislike')
  votes?: Record<string, 'like' | 'dislike'>
}

export interface CommentVote {
  commentId: string
  userId: string
  voteType: 'like' | 'dislike'
  createdAt: string
}
