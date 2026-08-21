package com.nearchat.mobile;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class PackageUnitTest {
    @Test
    public void packageNameIsStable() {
        assertEquals("com.nearchat.mobile", BuildConfig.APPLICATION_ID);
    }
}
