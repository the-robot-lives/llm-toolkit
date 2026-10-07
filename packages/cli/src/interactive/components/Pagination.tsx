import React from "react";
import { Box, Text } from "ink";

interface PaginationProps {
  page: number;
  totalPages: number;
  totalItems: number;
}

// <REMOVED UUID HERE> Pagination :: auto-generated pointer for public function Pagination
export function Pagination({ page, totalPages, totalItems }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <Box>
      <Text dimColor>
        Page {page}/{totalPages} ({totalItems} total) — n:next p:prev
      </Text>
    </Box>
  );
}
