import * as assert from 'assert';
import { sourcePreambleLineCount } from '../../../comments/sourcePreamble';

suite('Source conversion preamble placement', () => {
    test('preserves a Python shebang followed by an encoding cookie', () => {
        assert.strictEqual(
            sourcePreambleLineCount(['#!/usr/bin/env python3', '# -*- coding: latin-1 -*-', 'print("ok")'], 'python'),
            2
        );
    });

    test('preserves encoding cookies on either permitted Python line', () => {
        assert.strictEqual(sourcePreambleLineCount(['# coding=utf-8', 'print("ok")'], 'python'), 1);
        assert.strictEqual(
            sourcePreambleLineCount(['# launcher note', '# coding: cp1252', 'print("ok")'], 'python'),
            2
        );
    });

    test('preserves one-line language preambles', () => {
        assert.strictEqual(sourcePreambleLineCount(['#!/bin/sh', 'echo ok'], 'shellscript'), 1);
        assert.strictEqual(sourcePreambleLineCount(['<?xml version="1.0"?>', '<root/>'], 'xml'), 1);
        assert.strictEqual(sourcePreambleLineCount(['@charset "UTF-8";', 'body {}'], 'css'), 1);
    });

    test('returns zero for ordinary code', () => {
        assert.strictEqual(sourcePreambleLineCount(['const value = 1;'], 'typescript'), 0);
    });
});
