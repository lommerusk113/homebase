/** What a Discuss send types: the user's words behind a lead-in, so Claude sees it as a request to talk, not a pick. */
export const DISCUSS_LEAD = "Let's discuss this before choosing: ";
export const discussText = (text: string) => DISCUSS_LEAD + text;
